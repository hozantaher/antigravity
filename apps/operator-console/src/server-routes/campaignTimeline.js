// campaignTimeline.js — Sprint L3 (#1288)
//
// BFF route: GET /api/campaigns/:id/timeline?limit=50&offset=0
//
// Returns per-contact chronological event list for a campaign:
//   - type: 'sent' | 'reply_received' | 'thread_closed' | 'sequence_skipped'
//   - Sorted by most recent activity (send or reply), most-active contacts first.
//   - Max limit=50 to prevent accidental large scans.
//
// PII POLICY (feedback_no_pii_in_commands T0):
//   - Response body carries email/name (UI needs them).
//   - slog/console calls use contact_id only — never log email inline.
//
// Tables joined:
//   send_events se       — sent events (step, subject, status, sent_at)
//   reply_inbox ri       — inbound replies (classification, received_at)
//   outreach_threads ot  — thread state (status, updated_at) for closed
//   campaign_contacts cc — skipped contacts (status='skipped', details.skip_reason)
//   contacts c           — email, first_name, last_name

const TIMELINE_LIMIT_MAX = 50

/**
 * Mount the campaign timeline BFF route.
 *
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool }} deps
 */
export function mountCampaignTimelineRoutes(app, { pool }) {
  // GET /api/campaigns/:id/timeline?limit=50&offset=0
  app.get('/api/campaigns/:id/timeline', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id, 10)
      if (!Number.isFinite(campaignId) || campaignId <= 0) {
        return res.status(400).json({ error: 'invalid campaign id' })
      }

      const rawLimit  = parseInt(req.query.limit  || '50', 10)
      const rawOffset = parseInt(req.query.offset || '0',  10)
      const limit  = Number.isFinite(rawLimit)  && rawLimit  > 0 ? Math.min(rawLimit,  TIMELINE_LIMIT_MAX) : 50
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

      // ── 1. Gather distinct contacts with activity in this campaign ────────
      // Union of: (a) contacts who have send_events, (b) contacts who are
      // campaign_contacts with status='skipped'. Sort by most recent event.
      const contactsResult = await pool.query(
        `SELECT c.id           AS contact_id,
                c.email,
                c.first_name,
                c.last_name,
                MAX(recent.ts) AS last_event_at
           FROM (
             SELECT se.contact_id,
                    MAX(GREATEST(se.sent_at, COALESCE(ri.received_at, se.sent_at))) AS ts
               FROM send_events se
               LEFT JOIN reply_inbox ri ON ri.send_event_id = se.id
              WHERE se.campaign_id = $1
              GROUP BY se.contact_id
             UNION ALL
             SELECT cc.contact_id,
                    MAX(cc.next_send_at) AS ts
               FROM campaign_contacts cc
              WHERE cc.campaign_id = $1
                AND cc.status = 'skipped'
                AND NOT EXISTS (
                    SELECT 1 FROM send_events se2
                     WHERE se2.campaign_id = $1
                       AND se2.contact_id = cc.contact_id
                )
              GROUP BY cc.contact_id
           ) AS recent
           JOIN contacts c ON c.id = recent.contact_id
          GROUP BY c.id, c.email, c.first_name, c.last_name
          ORDER BY last_event_at DESC NULLS LAST
          LIMIT $2 OFFSET $3`,
        [campaignId, limit, offset]
      )

      // True distinct-contact total — independent of limit/offset. total_contacts
      // must reflect the FULL matched set, not the page size; the page is capped
      // at TIMELINE_LIMIT_MAX so contacts.length under-reports for any campaign
      // with more contacts than one page. Mirrors the distinct-contact set the
      // paginated query above derives (send_events contacts ∪ skipped
      // campaign_contacts, joined to contacts).
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS total
           FROM (
             SELECT se.contact_id
               FROM send_events se
              WHERE se.campaign_id = $1
              GROUP BY se.contact_id
             UNION
             SELECT cc.contact_id
               FROM campaign_contacts cc
              WHERE cc.campaign_id = $1
                AND cc.status = 'skipped'
                AND NOT EXISTS (
                  SELECT 1 FROM send_events se2
                   WHERE se2.campaign_id = $1
                     AND se2.contact_id = cc.contact_id
                )
              GROUP BY cc.contact_id
           ) AS recent
           JOIN contacts c ON c.id = recent.contact_id`,
        [campaignId]
      )
      const totalContacts = countRows[0]?.total ?? 0

      if (contactsResult.rows.length === 0) {
        return res.json({ contacts: [], limit, offset, total_contacts: totalContacts })
      }

      const contactIds = contactsResult.rows.map(r => r.contact_id)

      // ── 2. Fetch all relevant events for these contacts in this campaign ──

      // 2a. Send events
      const sendsResult = await pool.query(
        `SELECT se.contact_id,
                se.id          AS send_event_id,
                se.step,
                se.subject     AS template,
                se.status,
                se.sent_at     AS ts
           FROM send_events se
          WHERE se.campaign_id = $1
            AND se.contact_id  = ANY($2)
          ORDER BY se.sent_at ASC`,
        [campaignId, contactIds]
      )

      // 2b. Reply events
      const repliesResult = await pool.query(
        `SELECT ri.contact_id,
                ri.send_event_id,
                ri.classification,
                ri.received_at AS ts
           FROM reply_inbox ri
          WHERE ri.campaign_id = $1
            AND ri.contact_id  = ANY($2)
          ORDER BY ri.received_at ASC`,
        [campaignId, contactIds]
      )

      // 2c. Thread closed events (latest close per contact)
      const threadsResult = await pool.query(
        `SELECT ot.contact_id,
                ot.updated_at  AS ts
           FROM outreach_threads ot
          WHERE ot.campaign_id = $1
            AND ot.contact_id  = ANY($2)
            AND ot.status      = 'closed'
          ORDER BY ot.updated_at ASC`,
        [campaignId, contactIds]
      )

      // 2d. Sequence-skipped events
      const skippedResult = await pool.query(
        `SELECT cc.contact_id,
                cc.details->>'skip_reason' AS reason,
                cc.next_send_at            AS ts
           FROM campaign_contacts cc
          WHERE cc.campaign_id = $1
            AND cc.contact_id  = ANY($2)
            AND cc.status      = 'skipped'`,
        [campaignId, contactIds]
      )

      // ── 3. Assemble per-contact event lists ───────────────────────────────

      // Index events by contact_id
      const sendsByContact   = _groupBy(sendsResult.rows,   'contact_id')
      const repliesByContact = _groupBy(repliesResult.rows, 'contact_id')
      const threadsByContact = _groupBy(threadsResult.rows, 'contact_id')
      const skippedByContact = _groupBy(skippedResult.rows, 'contact_id')

      const contacts = contactsResult.rows.map(c => {
        const cid = c.contact_id

        const events = []

        // Sent events
        for (const s of (sendsByContact.get(cid) || [])) {
          events.push({
            type:      'sent',
            step:      s.step,
            template:  s.template || null,
            timestamp: s.ts ? new Date(s.ts).toISOString() : null,
          })
        }

        // Reply received events
        for (const r of (repliesByContact.get(cid) || [])) {
          events.push({
            type:           'reply_received',
            step:           null,
            template:       null,
            timestamp:      r.ts ? new Date(r.ts).toISOString() : null,
            classification: r.classification || null,
          })
        }

        // Thread closed events
        for (const t of (threadsByContact.get(cid) || [])) {
          events.push({
            type:      'thread_closed',
            step:      null,
            template:  null,
            timestamp: t.ts ? new Date(t.ts).toISOString() : null,
          })
        }

        // Sequence skipped events
        for (const sk of (skippedByContact.get(cid) || [])) {
          events.push({
            type:      'sequence_skipped',
            step:      null,
            template:  null,
            timestamp: sk.ts ? new Date(sk.ts).toISOString() : null,
            reason:    sk.reason || null,
          })
        }

        // Sort all events chronologically
        events.sort((a, b) => {
          if (!a.timestamp) return 1
          if (!b.timestamp) return -1
          return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
        })

        return {
          contact_id: cid,
          email:      c.email,
          first_name: c.first_name || null,
          last_name:  c.last_name  || null,
          events,
        }
      })

      // Log using contact_id only (PII guard — feedback_no_pii_in_commands T0)
      console.log(
        `[campaignTimeline] campaign=${campaignId} contacts=${contacts.length} offset=${offset}`,
      )

      return res.json({
        contacts,
        limit,
        offset,
        total_contacts: totalContacts,
      })
    } catch (e) {
      console.error('[campaignTimeline] error campaign_id=%s:', req.params.id, e.message)
      return res.status(500).json({ error: 'internal server error' })
    }
  })
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Group an array of objects into a Map keyed by the given field.
 *
 * @template T
 * @param {T[]} rows
 * @param {keyof T} key
 * @returns {Map<any, T[]>}
 */
function _groupBy(rows, key) {
  const map = new Map()
  for (const row of rows) {
    const k = row[key]
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(row)
  }
  return map
}
