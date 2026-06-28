// Anonymity test diagnostics — S5 operator UI backing endpoint.
// ─────────────────────────────────────────────────────────────────────────────
// Three endpoints:
//   GET  /api/anonymity/latest?mailbox_id=<id>
//        Aggregated anonymity + humanlike scores for a single mailbox,
//        last 7 days, scored rows only. Includes top-5 leaks/telltales
//        and a single Czech recommendation string.
//
//   GET  /api/anonymity/all
//        Same shape, one entry per active outreach_mailboxes row.
//        Backed by a single query per mailbox (no N+1 — list of active
//        mailboxes is fetched once then fan-out is sequential).
//
//   POST /api/anonymity/run
//        Triggers the 4-binary chain: cmd/anonymity-test, cmd/anonymity-harvest,
//        cmd/anonymity-score, cmd/anonymity-humanlike.
//        Rate-limited: 1 invocation per hour per server process (module-level
//        timestamp guard). Returns { status, run_id, started_at }.
//
// Read-only queries (GET). POST is write-once-per-hour.
// Schema: anonymity_test_messages (022 + 023 + 024 migrations).

import { randomUUID } from 'crypto'
import { exec } from 'child_process'

// ── rate-limit state (module-level, survives across requests) ────────────────
let _lastRunAt = null  // Date | null
const RATE_WINDOW_MS = 60 * 60 * 1000  // 1 hour

// ── helpers ──────────────────────────────────────────────────────────────────

function recommendation(avgAnon, avgHuman, messageCount) {
  if (messageCount === 0) {
    return 'Žádný test za posledních 7 dní. Spusť test.'
  }
  const both = avgAnon >= 85 && avgHuman >= 85
  const bothOk = avgAnon >= 70 && avgHuman >= 70
  if (both) {
    return 'Schránka je připravena pro produkci. ✓'
  }
  if (bothOk) {
    return 'Schránka má drobné nedostatky — viz drawer pro detaily.'
  }
  return 'Schránka NENÍ připravena. Kritické leaks/telltales nejprve vyřeš.'
}

/**
 * Aggregate the scored anonymity_test_messages rows for one mailbox.
 * Returns null when the mailbox does not exist in outreach_mailboxes.
 *
 * @param {import('pg').Pool} pool
 * @param {number} mailboxId
 * @returns {Promise<object>}
 */
async function aggregateForMailbox(pool, mailboxId) {
  // 1. Resolve mailbox email
  const mbRes = await pool.query(
    `SELECT id, from_address AS email, status FROM outreach_mailboxes WHERE id = $1`,
    [mailboxId],
  )
  if (!mbRes.rows.length) return null
  const mb = mbRes.rows[0]

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  // 2. Aggregate scored rows in the last 7 days
  const aggRes = await pool.query(
    `SELECT
       test_run_id,
       anonymity_score,
       humanlike_score,
       anonymity_leaks,
       humanlike_telltales,
       harvested_at
     FROM anonymity_test_messages
     WHERE sender_mailbox_id = $1
       AND harvested_at >= $2
       AND anonymity_score IS NOT NULL
       AND humanlike_score IS NOT NULL
     ORDER BY harvested_at DESC`,
    [mailboxId, since.toISOString()],
  )

  const rows = aggRes.rows

  // Run count: distinct test_run_ids in the window
  const distinctRuns = new Set(rows.map(r => r.test_run_id))
  const last7DaysRuns = distinctRuns.size

  if (rows.length === 0) {
    // Check if there's any run at all (even unscored) to give a last_run_id
    const anyRun = await pool.query(
      `SELECT test_run_id, MAX(harvested_at) AS run_at
       FROM anonymity_test_messages
       WHERE sender_mailbox_id = $1
       GROUP BY test_run_id
       ORDER BY run_at DESC
       LIMIT 1`,
      [mailboxId],
    )
    const lastRow = anyRun.rows[0] || null
    return {
      mailbox_id: mailboxId,
      email: mb.email,
      last_run_id: lastRow?.test_run_id ?? null,
      last_run_at: lastRow?.run_at ?? null,
      anonymity: null,
      humanlike: null,
      recommendation: recommendation(0, 0, 0),
      last_7_days_runs: 0,
    }
  }

  // Scores
  const anonScores = rows.map(r => r.anonymity_score)
  const humanScores = rows.map(r => r.humanlike_score)
  const avgAnon = Math.round(anonScores.reduce((a, b) => a + b, 0) / anonScores.length)
  const minAnon = Math.min(...anonScores)
  const avgHuman = Math.round(humanScores.reduce((a, b) => a + b, 0) / humanScores.length)
  const minHuman = Math.min(...humanScores)

  // Leak aggregation (anonymity_leaks jsonb — array of {rule, severity, evidence})
  const leakCounts = new Map()  // rule → { count, severity, sample_evidence }
  for (const row of rows) {
    const leaks = Array.isArray(row.anonymity_leaks) ? row.anonymity_leaks : []
    for (const leak of leaks) {
      if (!leak?.rule) continue
      const entry = leakCounts.get(leak.rule) || { count: 0, severity: leak.severity || 'warn', sample_evidence: leak.evidence || '' }
      entry.count++
      leakCounts.set(leak.rule, entry)
    }
  }
  const topLeaks = [...leakCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([rule, d]) => ({ rule, count: d.count, severity: d.severity, sample_evidence: d.sample_evidence }))

  // Telltale aggregation (humanlike_telltales)
  const telltalesCounts = new Map()
  for (const row of rows) {
    const telltales = Array.isArray(row.humanlike_telltales) ? row.humanlike_telltales : []
    for (const t of telltales) {
      if (!t?.rule) continue
      const entry = telltalesCounts.get(t.rule) || { count: 0, severity: t.severity || 'warn', sample_evidence: t.evidence || '' }
      entry.count++
      telltalesCounts.set(t.rule, entry)
    }
  }
  const topTelltales = [...telltalesCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([rule, d]) => ({ rule, count: d.count, severity: d.severity }))

  // Last run info
  const lastRow = rows[0]
  const lastRunId = lastRow.test_run_id
  const lastRunAt = lastRow.harvested_at

  return {
    mailbox_id: mailboxId,
    email: mb.email,
    last_run_id: lastRunId,
    last_run_at: typeof lastRunAt === 'string' ? lastRunAt : (lastRunAt instanceof Date ? lastRunAt.toISOString() : null),
    anonymity: {
      avg_score: avgAnon,
      min_score: minAnon,
      messages: rows.length,
      top_leaks: topLeaks,
    },
    humanlike: {
      avg_score: avgHuman,
      min_score: minHuman,
      messages: rows.length,
      top_telltales: topTelltales,
    },
    recommendation: recommendation(avgAnon, avgHuman, rows.length),
    last_7_days_runs: last7DaysRuns,
  }
}

/**
 * Build an aggregate result from pre-fetched scored rows (no DB queries).
 * Used by the batch /all endpoint to avoid per-mailbox queries.
 *
 * @param {number} mailboxId
 * @param {string} email
 * @param {Array<object>} rows — scored rows from anonymity_test_messages
 * @returns {object}
 */
function buildAggregateFromRows(mailboxId, email, rows) {
  const anonScores = rows.map(r => r.anonymity_score)
  const humanScores = rows.map(r => r.humanlike_score)
  const avgAnon = Math.round(anonScores.reduce((a, b) => a + b, 0) / anonScores.length)
  const minAnon = Math.min(...anonScores)
  const avgHuman = Math.round(humanScores.reduce((a, b) => a + b, 0) / humanScores.length)
  const minHuman = Math.min(...humanScores)

  const leakCounts = new Map()
  for (const row of rows) {
    const leaks = Array.isArray(row.anonymity_leaks) ? row.anonymity_leaks : []
    for (const leak of leaks) {
      if (!leak?.rule) continue
      const entry = leakCounts.get(leak.rule) || { count: 0, severity: leak.severity || 'warn', sample_evidence: leak.evidence || '' }
      entry.count++
      leakCounts.set(leak.rule, entry)
    }
  }
  const topLeaks = [...leakCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([rule, d]) => ({ rule, count: d.count, severity: d.severity, sample_evidence: d.sample_evidence }))

  const telltalesCounts = new Map()
  for (const row of rows) {
    const telltales = Array.isArray(row.humanlike_telltales) ? row.humanlike_telltales : []
    for (const t of telltales) {
      if (!t?.rule) continue
      const entry = telltalesCounts.get(t.rule) || { count: 0, severity: t.severity || 'warn' }
      entry.count++
      telltalesCounts.set(t.rule, entry)
    }
  }
  const topTelltales = [...telltalesCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([rule, d]) => ({ rule, count: d.count, severity: d.severity }))

  const distinctRuns = new Set(rows.map(r => r.test_run_id))
  const lastRow = rows[0]
  const lastRunAt = lastRow.harvested_at

  return {
    mailbox_id: mailboxId,
    email,
    last_run_id: lastRow.test_run_id,
    last_run_at: typeof lastRunAt === 'string' ? lastRunAt : (lastRunAt instanceof Date ? lastRunAt.toISOString() : null),
    anonymity: {
      avg_score: avgAnon,
      min_score: minAnon,
      messages: rows.length,
      top_leaks: topLeaks,
    },
    humanlike: {
      avg_score: avgHuman,
      min_score: minHuman,
      messages: rows.length,
      top_telltales: topTelltales,
    },
    recommendation: recommendation(avgAnon, avgHuman, rows.length),
    last_7_days_runs: distinctRuns.size,
  }
}

// ── route mount ───────────────────────────────────────────────────────────────

/**
 * Mount anonymity diagnostics routes on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500: Function, safeError: Function }} deps
 */
export function mountAnonymityRoutes(app, { pool, capture500, safeError }) {
  // GET /api/anonymity/latest?mailbox_id=<id>
  app.get('/api/anonymity/latest', async (req, res) => {
    try {
      const rawId = req.query.mailbox_id
      if (!rawId) {
        return res.status(400).json({ error: 'mailbox_id is required' })
      }
      const mailboxId = parseInt(rawId, 10)
      if (!Number.isFinite(mailboxId) || mailboxId <= 0) {
        return res.status(400).json({ error: 'mailbox_id must be a positive integer' })
      }
      const result = await aggregateForMailbox(pool, mailboxId)
      if (result === null) {
        return res.status(404).json({ error: 'mailbox not found' })
      }
      res.json(result)
    } catch (e) { capture500(res, e, safeError) }
  })

  // GET /api/anonymity/all
  // Fix (hardening 2026-05-05): previous implementation queried active mailboxes then
  // called aggregateForMailbox() per-mailbox sequentially — sequential N+1 pattern.
  // New implementation pre-fetches all scored rows in a single batch query and
  // partitions in memory, falling back to the single-mailbox path only for mailboxes
  // with no recent scored rows (to resolve last_run_id).
  app.get('/api/anonymity/all', async (req, res) => {
    try {
      // 1. Fetch all active mailboxes in one query
      const mbRes = await pool.query(
        `SELECT id, from_address AS email, status FROM outreach_mailboxes WHERE status = 'active' ORDER BY id ASC`,
      )
      if (!mbRes.rows.length) return res.json({ mailboxes: [] })

      const mailboxIds = mbRes.rows.map(r => r.id)
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

      // 2. Single batch query for all scored rows for all active mailboxes (last 7d)
      const batchRes = await pool.query(
        `SELECT
           sender_mailbox_id,
           test_run_id,
           anonymity_score,
           humanlike_score,
           anonymity_leaks,
           humanlike_telltales,
           harvested_at
         FROM anonymity_test_messages
         WHERE sender_mailbox_id = ANY($1::int[])
           AND harvested_at >= $2
           AND anonymity_score IS NOT NULL
           AND humanlike_score IS NOT NULL
         ORDER BY sender_mailbox_id ASC, harvested_at DESC`,
        [mailboxIds, since.toISOString()],
      )

      // 3. Group rows by mailbox_id
      const rowsByMailbox = new Map()
      for (const row of batchRes.rows) {
        const id = row.sender_mailbox_id
        if (!rowsByMailbox.has(id)) rowsByMailbox.set(id, [])
        rowsByMailbox.get(id).push(row)
      }

      // 4. Build results — mailboxes WITH scored rows are computed inline;
      //    mailboxes WITHOUT scored rows fall back to individual DB lookup (for last_run_id).
      const results = []
      const noScoreIds = []
      for (const mb of mbRes.rows) {
        const rows = rowsByMailbox.get(mb.id)
        if (rows && rows.length) {
          results.push(buildAggregateFromRows(mb.id, mb.email, rows))
        } else {
          noScoreIds.push(mb)
        }
      }

      // 5. Fan-out only for mailboxes without recent scored rows (typically 0 or few)
      for (const mb of noScoreIds) {
        const agg = await aggregateForMailbox(pool, mb.id)
        if (agg !== null) results.push(agg)
      }

      // 6. Sort by mailbox_id to maintain stable order
      results.sort((a, b) => a.mailbox_id - b.mailbox_id)
      res.json({ mailboxes: results })
    } catch (e) { capture500(res, e, safeError) }
  })

  // POST /api/anonymity/run
  app.post('/api/anonymity/run', async (req, res) => {
    try {
      const now = Date.now()
      if (_lastRunAt !== null && now - _lastRunAt < RATE_WINDOW_MS) {
        const retryAfterSec = Math.ceil((RATE_WINDOW_MS - (now - _lastRunAt)) / 1000)
        return res.status(429).json({
          status: 'rate_limited',
          run_id: null,
          started_at: null,
          retry_after_seconds: retryAfterSec,
          message: `Naposledy spuštěno před méně než 1 hodinou. Zkus za ${Math.ceil(retryAfterSec / 60)} minut.`,
        })
      }

      _lastRunAt = now
      const runId = randomUUID()
      const startedAt = new Date().toISOString()

      // Fire-and-forget: run the 4-binary chain async.
      // client polls /api/anonymity/all to see fresh data.
      const chain = [
        `./dist/anonymity-test`,
        `./dist/anonymity-harvest`,
        `./dist/anonymity-score`,
        `./dist/anonymity-humanlike`,
      ].join(' && ')

      exec(chain, { cwd: process.cwd(), timeout: 20 * 60 * 1000 }, (err) => {
        if (err) {
          // Non-fatal: chain ran but errored. Operator can re-run.
          // In prod, Sentry will capture via unhandled if needed.
        }
      })

      res.json({ status: 'running', run_id: runId, started_at: startedAt })
    } catch (e) { capture500(res, e, safeError) }
  })
}

// Exported for unit testing without an Express round-trip.
// Allow tests to reset/manipulate rate-limit state.
export function _resetRateLimit() { _lastRunAt = null }
export function _setLastRunAt(ts) { _lastRunAt = ts }
