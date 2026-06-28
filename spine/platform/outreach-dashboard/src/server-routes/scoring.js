// Scoring + ranking route surface — dual-axis ranking, lookalike centroid,
// scoring config CRUD, scoring preview, recompute-all, learn (logistic),
// scoring stats.
// ─────────────────────────────────────────────────────────────────────────────
// D2.5 (2026-05-02): extracted verbatim from server.js per ADR-008 D2 module
// sequence (after D2.2 mountCompaniesRoutes #660). Behavior is byte-equivalent
// to the inline declarations: same SQL, same response shape, same Sentry
// capture, same Express route ordering.
//
// Routes covered (8 total):
//   GET  /api/dual-axis                  — top-N (EV × readiness) ranking
//   GET  /api/lookalike/centroid         — converter centroid debug surface
//   GET  /api/scoring/config             — read scoring weights (+ version)
//   PUT  /api/scoring/config             — upsert scoring weights (validates 0..1000)
//   POST /api/scoring/preview            — degraded-fallback preview ranker
//   POST /api/scoring/recompute-all      — bulk score recompute (cap 10000)
//   POST /api/scoring/learn              — logistic gate-checked weight suggestion
//   GET  /api/scoring/stats              — tier counts + stale (>7d) count
//
// Helpers (DEFAULT_WEIGHTS, getScoringWeights, recomputeScoreForIco,
// computeEngagementForCompanies, loadSectorEngagementPriors, priorsForSector,
// computeExpectedValueScore, computeReadiness, loadLookalikeCentroid,
// computeCompositeScore, extractFeatures, trainLogistic,
// suggestScoringWeights, SCORE_LEARNER_LIMITS) STAY in server.js because
// non-scoring code paths (companies routes, full-check cron, scoring
// recompute cron) also call them. They are passed in via `deps`.

/**
 * Mount the Scoring + ranking route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   setRouteTags: (tags: Record<string, unknown>) => void,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 *   DEFAULT_WEIGHTS: Record<string, number>,
 *   getScoringWeights: () => Promise<Record<string, number>>,
 *   recomputeScoreForIco: (ico: string, weights?: unknown, sectorPriors?: unknown) => Promise<unknown>,
 *   computeEngagementForCompanies: (companyIds: number[]) => Promise<Map<number, { engagement_score: number, recent_60d_count: number }>>,
 *   loadSectorEngagementPriors: () => Promise<Map<string, unknown>>,
 *   priorsForSector: (map: Map<string, unknown> | null, sectorPrimary: string | null) => unknown,
 *   computeExpectedValueScore: (co: unknown, fixed: unknown, opts: unknown) => { ev_score: number, propensity: number, size_proxy: number },
 *   computeReadiness: (co: unknown, facts: unknown) => { score: number },
 *   loadLookalikeCentroid: (force?: boolean) => Promise<{ vec: unknown, builtAt: number, n: number }>,
 *   computeCompositeScore: (row: unknown, weights: unknown, opts: unknown) => { score: number, tier: string },
 *   extractFeatures: (row: unknown) => unknown,
 *   trainLogistic: (samples: unknown[], opts: unknown) => { ok: boolean, gate?: unknown, loss: number },
 *   suggestScoringWeights: (learned: unknown, current: unknown) => { raw: unknown, weights: unknown } | null,
 *   SCORE_LEARNER_LIMITS: unknown,
 * }} deps
 */
export function mountScoringRoutes(app, deps) {
  const {
    pool,
    setRouteTags,
    capture500,
    safeError,
    DEFAULT_WEIGHTS,
    getScoringWeights,
    recomputeScoreForIco,
    computeEngagementForCompanies,
    loadSectorEngagementPriors,
    priorsForSector,
    computeExpectedValueScore,
    computeReadiness,
    loadLookalikeCentroid,
    computeCompositeScore,
    extractFeatures,
    trainLogistic,
    suggestScoringWeights,
    SCORE_LEARNER_LIMITS,
  } = deps

  // Dual-axis ranking — top N companies by (EV × readiness). The "value × moment"
  // matrix that operators pull a daily call list from.
  app.get('/api/dual-axis', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50))
      const candidatePool = Math.max(limit, Math.min(500, Number(req.query.pool) || 200))
      const { rows: cos } = await pool.query(`
        SELECT id, ico, name, icp_tier, email_confidence, sector_confidence, velikost_firmy,
               email, email_status, exclusion_status, website, sector_primary, last_contacted,
               total_sent, total_replied, total_opened, total_bounced,
               datum_zaniku, v_likvidaci, v_insolvenci, composite_score, score_tier
          FROM companies
         WHERE exclusion_status = 'pass' AND email IS NOT NULL
         ORDER BY composite_score DESC NULLS LAST, id DESC
         LIMIT $1
      `, [candidatePool])
      if (cos.length === 0) return res.json({ count: 0, items: [] })
      const ids = cos.map(c => c.id)
      const { rows: facts } = await pool.query(
        `SELECT company_id, field, value FROM company_current_facts
          WHERE company_id = ANY($1) AND field IN ('mx_provider','spf','dmarc')`,
        [ids],
      )
      const factsByCo = new Map()
      for (const f of facts) {
        const arr = factsByCo.get(f.company_id) || []
        arr.push({ field: f.field, value: f.value })
        factsByCo.set(f.company_id, arr)
      }
      const [sectorPriors, engagementById] = await Promise.all([
        loadSectorEngagementPriors(),
        computeEngagementForCompanies(ids),
      ])
      const items = []
      for (const co of cos) {
        const { engagement_score, recent_60d_count } =
          engagementById.get(co.id) || { engagement_score: 0, recent_60d_count: 0 }
        const ep = priorsForSector(sectorPriors, co.sector_primary)
        const ev = computeExpectedValueScore(
          { ...co, engagement_score, recent_60d_count },
          null, ep ? { engagementPriors: ep } : {},
        )
        const ready = computeReadiness({
          ...co,
          status: co.exclusion_status === 'pass' ? 'active' : co.exclusion_status,
          recent_60d_count,
        }, factsByCo.get(co.id) || [])
        items.push({
          ico: co.ico, name: co.name, sector: co.sector_primary,
          ev_score: ev.ev_score, propensity: ev.propensity, size_proxy: ev.size_proxy,
          readiness_score: ready.score,
          dual_axis: Math.round((ev.ev_score * ready.score) / 100),
        })
      }
      items.sort((a, b) => b.dual_axis - a.dual_axis)
      res.json({ count: items.length, items: items.slice(0, limit) })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/lookalike/centroid', async (req, res) => {
    try {
      const force = req.query.force === '1'
      const c = await loadLookalikeCentroid(force)
      res.json({ converters: c.n, built_at: new Date(c.builtAt).toISOString(), centroid: c.vec })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/scoring/config', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT weights, version, updated_at, updated_by FROM scoring_config WHERE id=1`)
      if (!rows.length) return res.json({ weights: DEFAULT_WEIGHTS, version: 0 })
      res.json(rows[0])
    } catch (e) { capture500(res, e, safeError) }
  })

  app.put('/api/scoring/config', async (req, res) => {
    let client
    try {
      const incoming = req.body?.weights
      if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'weights required' })
      const merged = { ...DEFAULT_WEIGHTS, ...incoming }
      for (const k of Object.keys(merged)) {
        const n = Number(merged[k])
        if (!Number.isFinite(n) || n < 0 || n > 1000) {
          return res.status(400).json({ error: `invalid weight for ${k}` })
        }
        merged[k] = n
      }
      const updatedBy = req.body?.updated_by || 'ui'
      client = await pool.connect()
      await client.query('BEGIN')
      await client.query(`
        UPDATE scoring_config SET weights=$1::jsonb, version=version+1, updated_at=now(), updated_by=$2 WHERE id=1
      `, [JSON.stringify(merged), updatedBy])
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('scoring_config_update', 'dashboard', 'scoring_config', '1', $1::jsonb)`,
        [JSON.stringify({ updated_by: updatedBy, keys_updated: Object.keys(merged) })]
      )
      await client.query('COMMIT')
      const { rows } = await client.query(`SELECT weights, version, updated_at FROM scoring_config WHERE id=1`)
      res.json(rows[0])
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK') } catch {} }
      capture500(res, e, safeError)
    } finally {
      if (client) client.release()
    }
  })

  app.post('/api/scoring/preview', async (req, res) => {
    setRouteTags({ 'scoring.action': 'preview' })
    // Caught by 2026-04-30 visual smoke (`/api/scoring/preview → 500`).
    // Original query selected `c.engagement_score` and a correlated subquery
    // joining `send_events.company_id`. Either column drift on the prod
    // `companies` table or `send_events.company_id` being NULL/missing in
    // some rows can fail the whole query.
    //
    // Fix: split into two passes — primary (full feature set) and a degraded
    // fallback (omits engagement + recent_60d_count). The composite scorer
    // tolerates missing fields (treats them as 0), so the preview still
    // ranks/distributes correctly when we degrade.
    try {
      const weights = { ...DEFAULT_WEIGHTS, ...(req.body?.weights || {}) }
      const limit = Math.min(Number(req.body?.limit) || 200, 1000)
      const sectorPriors = await loadSectorEngagementPriors()

      let rows
      let degraded = false
      try {
        const result = await pool.query(`
          SELECT c.ico, c.name, c.icp_tier, c.email_confidence, c.sector_confidence, c.velikost_firmy,
                 c.email, c.datum_zaniku, c.v_likvidaci, c.v_insolvenci, c.sector_primary,
                 c.total_sent, c.total_replied, c.total_opened, c.total_bounced, c.last_contacted,
                 c.engagement_score,
                 (SELECT COUNT(*)::int FROM send_events se
                    WHERE se.company_id = c.id
                      AND se.sent_at > now() - INTERVAL '60 days') AS recent_60d_count
          FROM companies c
          WHERE c.datum_zaniku IS NULL
          ORDER BY c.best_targeting_score DESC NULLS LAST
          LIMIT $1
        `, [limit])
        rows = result.rows
      } catch (primaryErr) {
        // Retry with the minimum column set the scorer needs. If even this
        // fails, surface the original error so Sentry sees the real cause.
        try {
          const fallback = await pool.query(`
            SELECT c.ico, c.name, c.icp_tier, c.email_confidence, c.sector_confidence, c.velikost_firmy,
                   c.email, c.datum_zaniku, c.v_likvidaci, c.v_insolvenci, c.sector_primary,
                   c.total_sent, c.total_replied, c.total_opened, c.total_bounced, c.last_contacted
            FROM companies c
            WHERE c.datum_zaniku IS NULL
            ORDER BY c.best_targeting_score DESC NULLS LAST
            LIMIT $1
          `, [limit])
          rows = fallback.rows
          degraded = true
        } catch {
          return capture500(res, primaryErr, safeError)
        }
      }

      const scored = rows.map(r => {
        const sp = priorsForSector(sectorPriors, r.sector_primary)
        const opts = sp ? { engagementPriors: sp } : {}
        const { score, tier } = computeCompositeScore(r, weights, opts)
        return { ico: r.ico, name: r.name, score, tier }
      })
      const dist = { S: 0, A: 0, B: 0, C: 0, D: 0 }
      for (const s of scored) dist[s.tier] = (dist[s.tier] || 0) + 1
      const payload = { sample: scored, distribution: dist, sample_size: scored.length }
      if (degraded) payload.degraded = true
      res.json(payload)
    } catch (e) { capture500(res, e, safeError) }
  })

  app.post('/api/scoring/recompute-all', async (req, res) => {
    try {
      const limit = Math.min(Number(req.body?.limit) || 1000, 10000)
      const weights = await getScoringWeights()
      const sectorPriors = await loadSectorEngagementPriors()
      const { rows } = await pool.query(`
        SELECT ico FROM companies WHERE datum_zaniku IS NULL LIMIT $1
      `, [limit])
      let ok = 0
      for (const r of rows) {
        try { await recomputeScoreForIco(r.ico, weights, sectorPriors); ok++ } catch {}
      }
      res.json({ scored: ok, total_attempted: rows.length })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.post('/api/scoring/learn', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT score_components, total_replied
        FROM companies
        WHERE score_components IS NOT NULL AND total_sent > 0
        LIMIT 5000
      `)
      const samples = rows.map(r => ({
        features: extractFeatures({ score_components: r.score_components }),
        label: (r.total_replied > 0) ? 1 : 0,
      }))
      const learned = trainLogistic(samples, { epochs: 250, lr: 0.1 })
      if (!learned.ok) {
        return res.status(400).json({
          error: 'gate_failed',
          gate: learned.gate,
          limits: SCORE_LEARNER_LIMITS,
        })
      }
      const current = await getScoringWeights()
      const suggestion = suggestScoringWeights(learned, current)
      res.json({
        ok: true,
        samples: samples.length,
        positive: samples.filter(s => s.label === 1).length,
        loss: +learned.loss.toFixed(4),
        raw_weights: suggestion?.raw ?? null,
        suggested_weights: suggestion?.weights ?? null,
        current_weights: current,
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/scoring/stats', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT score_tier, COUNT(*)::int AS cnt,
               AVG(composite_score)::numeric(10,2) AS avg_score
        FROM companies
        WHERE datum_zaniku IS NULL AND composite_score IS NOT NULL
        GROUP BY score_tier ORDER BY score_tier
      `)
      const { rows: [stale] } = await pool.query(`
        SELECT COUNT(*)::int AS cnt FROM companies
        WHERE datum_zaniku IS NULL AND (scored_at IS NULL OR scored_at < now() - INTERVAL '7 days')
      `)
      res.json({ tiers: rows, stale: stale?.cnt ?? 0 })
    } catch (e) { capture500(res, e, safeError) }
  })
}
