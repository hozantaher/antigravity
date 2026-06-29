// BFF — AP2 operator endpoint for forced mailbox egress repin.
//
// Sprint AP2 (2026-05-08): Mailbox egress pin is locked on first send/probe.
// This module exposes an operator-only escape hatch for repinning a mailbox
// to a different Mullvad endpoint when the pinned endpoint becomes permanently
// degraded (e.g. Mullvad server decommissioned, sustained packet loss).
//
// Route:
//   POST /api/mailboxes/:id/repin
//   Body: { new_endpoint_label: string, reason: string }
//   Headers: X-API-Key (BFF key)
//
// On success:
//   - Inserts an audit row into mailbox_egress_repin_audit
//   - Updates outreach_mailboxes.pinned_endpoint_label
//   Returns 200 { mailbox_id, old_label, new_label, reason }
//
// Rejects:
//   - Missing / empty reason → 400
//   - Mailbox not found → 404
//   - DB error → 500

/**
 * Mount the mailbox repin route on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   setRouteTags: (tags: Record<string, unknown>) => void,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountMailboxRepinRoute(app, { pool, setRouteTags, capture500, safeError }) {
  app.post('/api/mailboxes/:id/repin', async (req, res) => {
    setRouteTags({ route: 'POST /api/mailboxes/:id/repin' })
    const id = parseInt(req.params.id, 10)
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'invalid mailbox id' })

    const { new_endpoint_label, reason } = req.body ?? {}
    if (!new_endpoint_label || typeof new_endpoint_label !== 'string' || !new_endpoint_label.trim()) {
      return res.status(400).json({ error: 'new_endpoint_label is required' })
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required' })
    }

    // P2 FIX: validate operator ID against allowlist to prevent injection
    const allowed = (process.env.ALLOWED_OPERATOR_IDS || 'operator,tomas,messing').split(',').map(s => s.trim())
    const operatorId = req.headers['x-operator-id'] || 'operator'
    if (!allowed.includes(operatorId)) {
      return res.status(403).json({ error: 'invalid_operator', id: operatorId })
    }
    const actor = operatorId

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Fetch current pin for audit row.
      const { rows: mbRows } = await client.query(
        `SELECT id, from_address, pinned_endpoint_label
           FROM outreach_mailboxes
          WHERE id = $1`,
        [id]
      )
      if (!mbRows.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'mailbox not found' })
      }

      const oldLabel = mbRows[0].pinned_endpoint_label ?? null

      // Insert audit row.
      await client.query(
        `INSERT INTO mailbox_egress_repin_audit
           (mailbox_id, old_label, new_label, reason, actor)
           VALUES ($1, $2, $3, $4, $5)`,
        [id, oldLabel, new_endpoint_label.trim(), reason.trim(), actor]
      )

      // Update the pin.
      await client.query(
        `UPDATE outreach_mailboxes
            SET pinned_endpoint_label = $1,
                pinned_endpoint_at    = NOW(),
                pinned_endpoint_by    = $2
          WHERE id = $3`,
        [new_endpoint_label.trim(), actor, id]
      )

      await client.query('COMMIT')

      console.log(`[mailboxesRepin] mailbox ${id} repinned: ${oldLabel ?? '(none)'} → ${new_endpoint_label.trim()} by ${actor} — ${reason.trim()}`)

      return res.json({
        mailbox_id: id,
        old_label: oldLabel,
        new_label: new_endpoint_label.trim(),
        reason: reason.trim(),
        actor,
      })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      return capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })
}
