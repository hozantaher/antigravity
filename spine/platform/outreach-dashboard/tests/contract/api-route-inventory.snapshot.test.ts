/**
 * BFF route inventory snapshot
 *
 * Parses server.js and asserts the full set of registered routes. Any
 * accidental addition/removal/renaming of an Express route flips this test —
 * forcing a deliberate choice and contract update.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

type Route = { method: string; path: string }

// T3.x (2026-05-01): BFF routes are split across two source styles:
//
//   1. server.js         — top-level `app.<method>(...)` (start of line)
//   2. src/server-routes/*.js — mount-function style: `  app.<method>(...)`
//                              (indented inside `export function mountXxxRoutes(app, deps)`)
//
// The inventory scanner must cover both to produce a complete route list.
// When a new mounter module is added to src/server-routes/, no scanner change
// is needed — the glob picks it up automatically. Only EXPECTED_ROUTES needs
// updating to acknowledge the new routes.
const SERVER_PATH = resolve(__dirname, '../../server.js')
const SERVER_ROUTES_DIR = resolve(__dirname, '../../src/server-routes')

const src = readFileSync(SERVER_PATH, 'utf8')
const serverRoutesSrcs: string[] = readdirSync(SERVER_ROUTES_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(resolve(SERVER_ROUTES_DIR, f), 'utf8'))

function collectRoutes(): Route[] {
  // Regex styles:
  //   appRe       — `^app.<method>('path'` (top-level, start of line)
  //   indentedRe  — `  app.<method>('path'` (indented inside mount function)
  const appRe       = /^app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gm
  const indentedRe  = /^\s+app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gm
  const out: Route[] = []
  for (const m of src.matchAll(appRe)) {
    out.push({ method: m[1].toUpperCase(), path: m[2] })
  }
  for (const moduleSrc of serverRoutesSrcs) {
    for (const m of moduleSrc.matchAll(indentedRe)) {
      out.push({ method: m[1].toUpperCase(), path: m[2] })
    }
  }
  return out
}

const routes = collectRoutes()
const keys = routes.map((r) => `${r.method} ${r.path}`).sort()
const uniqKeys = Array.from(new Set(keys))

/**
 * Canonical frozen list. Review every change — if something is legitimately
 * added or removed, regenerate and commit.
 *
 * v2 unification (feat/dashboard-unification-v2) added ~102 new routes:
 * vehicles, icp-sectors, verify-loop, relay, notifications, operator-metrics,
 * mailbox reputation/delivery/bounce stats, reply stream, audit/recent,
 * campaign sub-routes (dry-run, expand-segments, filter-tier, skip-by-domains,
 * unskip, segment/apply, halt-advisory, in-flight-count, etc.), and more.
 *
 * KNOWN VIOLATIONS in this snapshot (flagged, not relaxed):
 *   - PATCH /api/campaigns/:id/contacts/:contact_id/reset-next-send
 *     and POST /api/failed-sends/:cc_id/reset use underscore in param names
 *     (:contact_id, :cc_id) — violates the camelCase convention enforced by
 *     the "param names are lowercase with optional dashes" test. Fix: rename
 *     params to :contactId / :ccId in src/server-routes/campaigns.js (or
 *     wherever they are registered). SHARED_EDITS_NEEDED.
 *   - 4 duplicate (method, path) pairs exceed the baseline of 3:
 *     GET /api/dns-audit (server.js + dnsAudit.js),
 *     GET /api/leads (leads.js + replies.js),
 *     PATCH /api/leads/:id (leads.js + replies.js),
 *     GET /api/replies/stats (replies.js + repliesStats.js).
 *     Fix: remove the duplicate registrations from the secondary files.
 *     SHARED_EDITS_NEEDED.
 */
const EXPECTED_ROUTES: string[] = [
  'DELETE /api/campaigns/:id',
  'DELETE /api/contacts/:id',
  'DELETE /api/icp-sectors/:id',
  'DELETE /api/mailboxes/:id',
  'DELETE /api/segments/:id',
  'DELETE /api/suppression/:email',
  'DELETE /api/templates/:id',
  'DELETE /api/vehicles/:id',
  'GET /api/__schema-check',
  'GET /api/alerts/stream',
  'GET /api/analytics/campaigns',
  'GET /api/analytics/overview',
  'GET /api/analytics/timeline',
  'GET /api/anonymity/all',
  'GET /api/anonymity/latest',
  'GET /api/anti-trace/egress',
  'GET /api/anti-trace/health',
  'GET /api/attachments/:id/blob',
  'GET /api/audit/recent',
  'GET /api/campaigns',
  'GET /api/campaigns/:id',
  'GET /api/campaigns/:id/best-time',
  'GET /api/campaigns/:id/capacity',
  'GET /api/campaigns/:id/email-quality',
  'GET /api/campaigns/:id/estimate',
  'GET /api/campaigns/:id/halt-advisory',
  'GET /api/campaigns/:id/in-flight-count',
  'GET /api/campaigns/:id/inbox-placement',
  'GET /api/campaigns/:id/launch-stats',
  'GET /api/campaigns/:id/preflight',
  'GET /api/campaigns/:id/priority-distribution',
  'GET /api/campaigns/:id/ramp-progress',
  'GET /api/campaigns/:id/reply-projection',
  'GET /api/campaigns/:id/sends',
  'GET /api/campaigns/:id/timeline',
  'GET /api/campaigns/last-24h-summary',
  'GET /api/categories',
  'GET /api/categories/:slug',
  'GET /api/categories/:slug/companies',
  'GET /api/category-tree',
  'GET /api/classifier/overrides',
  'GET /api/cohorts/lookup',
  'GET /api/companies',
  'GET /api/companies/:ico',
  'GET /api/companies/:ico/data-quality',
  'GET /api/companies/:ico/expected-value',
  'GET /api/companies/:ico/facts',
  'GET /api/companies/:ico/facts/current',
  'GET /api/companies/:ico/lookalike',
  'GET /api/companies/:ico/readiness',
  'GET /api/companies/:ico/verification-history',
  'GET /api/companies/:id/timeline',
  'GET /api/companies/facets',
  'GET /api/companies/regions',
  'GET /api/companies/score-trends',
  'GET /api/companies/sectors',
  'GET /api/companies/stats',
  'GET /api/contacts',
  'GET /api/contacts/:id',
  'GET /api/contacts/verify/progress',
  'GET /api/crm/clients',
  'GET /api/crm/clients/:id',
  'GET /api/crm/clients/freshness',
  'GET /api/crm/clients/stats',
  'GET /api/dashboard/live-activity',
  'GET /api/dashboard/metrics',
  'GET /api/dashboard/metrics-stream',
  'GET /api/dashboard/summary',
  'GET /api/data-quality',
  'GET /api/dedup-guard/contact-block-reason',
  'GET /api/dedup-guard/recent-skips',
  'GET /api/dedup-guard/segment-funnel',
  'GET /api/dedup-guard/stats',
  'GET /api/diagnostics/feature-lift',
  'GET /api/diagnostics/segmentation',
  'GET /api/dns-audit',
  'GET /api/dsr/access',
  'GET /api/dual-axis',
  'GET /api/email-verification/stats',
  'GET /api/failed-sends',
  'GET /api/funnel/summary',
  'GET /api/healing/log',
  'GET /api/healing/stats',
  'GET /api/health',
  'GET /api/health/auth-fail-alerts',
  'GET /api/health/cron-heartbeats',
  'GET /api/health/drift',
  'GET /api/health/guards',
  'GET /api/health/invariants',
  'GET /api/health/protections',
  'GET /api/health/proxy-exhaust',
  'GET /api/health/proxy-sources',
  'GET /api/health/system',
  'GET /api/health/test-quality',
  'GET /api/health/watchdog',
  'GET /api/icp-sectors',
  'GET /api/ingest-freshness',
  'GET /api/launch-readiness',
  'GET /api/launch-sanity',
  'GET /api/leads',
  'GET /api/lookalike/centroid',
  'GET /api/mailboxes',
  'GET /api/mailboxes/:id',
  'GET /api/mailboxes/:id/alerts',
  'GET /api/mailboxes/:id/bounce-status',
  'GET /api/mailboxes/:id/campaigns',
  'GET /api/mailboxes/:id/check-history',
  'GET /api/mailboxes/:id/config-check',
  'GET /api/mailboxes/:id/cooldown-log',
  'GET /api/mailboxes/:id/egress-history',
  'GET /api/mailboxes/:id/full-check',
  'GET /api/mailboxes/:id/health-history',
  'GET /api/mailboxes/:id/imap-check',
  'GET /api/mailboxes/:id/imap-inbox',
  'GET /api/mailboxes/:id/pipeline-results',
  'GET /api/mailboxes/:id/pipeline-status',
  'GET /api/mailboxes/:id/proxy-live-check',
  'GET /api/mailboxes/:id/send-log',
  'GET /api/mailboxes/:id/send-rate',
  'GET /api/mailboxes/:id/smtp-check',
  'GET /api/mailboxes/:id/stats',
  'GET /api/mailboxes/:id/today-usage',
  'GET /api/mailboxes/:id/warmup-status',
  'GET /api/mailboxes/:id/watchdog-events',
  'GET /api/mailboxes/blacklist-alerts',
  'GET /api/mailboxes/bounce-stats',
  'GET /api/mailboxes/bounce-warnings',
  'GET /api/mailboxes/delivery-time-stats',
  'GET /api/mailboxes/health-stream',
  'GET /api/mailboxes/health-summary',
  'GET /api/mailboxes/reputation-history',
  'GET /api/mailboxes/reputation-score',
  'GET /api/mailboxes/send-trends',
  'GET /api/mailboxes/spam-complaint-stats',
  'GET /api/messages/:id/attachments/:idx',
  'GET /api/meta/categories',
  'GET /api/meta/categories/search',
  'GET /api/meta/categories/top',
  'GET /api/meta/categories/tree',
  'GET /api/metrics/mailboxes',
  'GET /api/notifications',
  'GET /api/operator-metrics/cluster-rate-live',
  'GET /api/operator-metrics/daily-summary',
  'GET /api/operator-settings',
  'GET /api/operator-settings/high-risk-domains',
  'GET /api/operator/api-key-status',
  'GET /api/operator/metrics',
  'GET /api/operator/queue',
  'GET /api/operator/queue/:suggestionId',
  'GET /api/prospects/stats',
  'GET /api/prospects/top',
  'GET /api/protections/alerts',
  'GET /api/protections/coverage',
  'GET /api/protections/matrix',
  'GET /api/protections/trace/:messageId',
  'GET /api/proxy-pool',
  'GET /api/proxy-pool-trend',
  'GET /api/relay/endpoint-health',
  'GET /api/relay/pool-capacity',
  'GET /api/relay/queue-depth',
  'GET /api/replies',
  'GET /api/replies/:id',
  'GET /api/replies/:id/attachments',
  'GET /api/replies/:id/classification',
  'GET /api/replies/:id/context',
  'GET /api/replies/:id/extracted-vehicles',
  'GET /api/replies/stats',
  'GET /api/replies/stream',
  'GET /api/reply-templates',
  'GET /api/scoring/config',
  'GET /api/scoring/stats',
  'GET /api/scraper/healing',
  'GET /api/search',
  'GET /api/segments',
  'GET /api/segments/:id/companies',
  'GET /api/segments/preview',
  'GET /api/suppression',
  'GET /api/synthetic-runs',
  'GET /api/templates',
  'GET /api/templates/metrics',
  'GET /api/templates/preview',
  'GET /api/templates/ranking',
  'GET /api/threads/:id/context',
  'GET /api/threads/:id/messages',
  'GET /api/threads/stream',
  'GET /api/vehicles',
  'GET /api/vehicles/:id',
  'GET /api/verify-loop/queue',
  'GET /api/verify-loop/status',
  'GET /api/verify-queue/health',
  'GET /api/version',
  'GET /privacy',
  'GET /unsubscribe',
  'PATCH /api/campaigns/:id',
  'PATCH /api/campaigns/:id/contacts/:contact_id/reset-next-send',
  'PATCH /api/companies/:ico',
  'PATCH /api/contacts/:id',
  'PATCH /api/icp-sectors/:id',
  'PATCH /api/leads/:id',
  'PATCH /api/mailboxes/:id',
  'PATCH /api/mailboxes/:id/alerts/:alertId/resolve',
  'PATCH /api/mailboxes/:id/lifecycle-phase',
  'PATCH /api/mailboxes/:id/status',
  'PATCH /api/mailboxes/:id/warmup',
  'PATCH /api/replies/:id',
  'PATCH /api/replies/:id/classify',
  'PATCH /api/replies/:id/flag',
  'PATCH /api/replies/:id/handled',
  'PATCH /api/segments/:id',
  'PATCH /api/vehicles/:id',
  'POST /api/anonymity/run',
  'POST /api/campaigns',
  'POST /api/campaigns/:id/dry-run',
  'POST /api/campaigns/:id/expand-segments',
  'POST /api/campaigns/:id/filter-tier',
  'POST /api/campaigns/:id/pause',
  'POST /api/campaigns/:id/rescore-priority',
  'POST /api/campaigns/:id/reset-next-send-at',
  'POST /api/campaigns/:id/run',
  'POST /api/campaigns/:id/segment/apply',
  'POST /api/campaigns/:id/send-batch',
  'POST /api/campaigns/:id/send-test',
  'POST /api/campaigns/:id/skip-by-domains',
  'POST /api/campaigns/:id/unskip',
  'POST /api/campaigns/pause-all',
  'POST /api/category-tree/select',
  'POST /api/companies/:ico/facts',
  'POST /api/companies/:ico/recompute-score',
  'POST /api/companies/:ico/verify-email',
  'POST /api/companies/bulk-verify-email',
  'POST /api/contacts/:id/reverify',
  'POST /api/contacts/:id/verify-email',
  'POST /api/contacts/verify/bulk-enqueue',
  'POST /api/contacts/verify/pause',
  'POST /api/contacts/verify/resume',
  'POST /api/contacts/verify/tick',
  'POST /api/crm/clients/import',
  'POST /api/data-quality/fix/reply-mime-subject',
  'POST /api/dsr/erase',
  'POST /api/enrichment/refresh-plan/run',
  'POST /api/failed-sends/:cc_id/reset',
  'POST /api/health/auto-recover-trigger',
  'POST /api/icp-sectors',
  'POST /api/leads',
  'POST /api/mailboxes',
  'POST /api/mailboxes/:id/assign-proxy',
  'POST /api/mailboxes/:id/auth-reset',
  'POST /api/mailboxes/:id/clear-auth-lock',
  'POST /api/mailboxes/:id/diagnose',
  'POST /api/mailboxes/:id/header-probe',
  'POST /api/mailboxes/:id/pipeline-test',
  'POST /api/mailboxes/:id/recover',
  'POST /api/mailboxes/:id/refresh-imap',
  'POST /api/mailboxes/:id/repin',
  'POST /api/mailboxes/:id/send-test',
  'POST /api/mailboxes/:id/warmup/start',
  'POST /api/mailboxes/anonymity-probe',
  'POST /api/mailboxes/blacklist-alerts/:id/resolve',
  'POST /api/mailboxes/bulk-assign-proxy',
  'POST /api/mailboxes/bulk-check',
  'POST /api/mailboxes/bulk-pause',
  'POST /api/mailboxes/bulk-resume',
  'POST /api/mailboxes/bulk-set-password',
  'POST /api/notifications/:id/resolve',
  'POST /api/operator/approve',
  'POST /api/operator/rotate-api-key',
  'POST /api/protections/alerts/:id/ack',
  'POST /api/replies/:id/auto-classify',
  'POST /api/replies/:id/draft-reply',
  'POST /api/replies/:id/forward-to-crm',
  'POST /api/replies/:id/forward-to-garaaage',
  'POST /api/replies/:id/reply',
  'POST /api/replies/bulk-handled',
  'POST /api/replies/bulk-revert',
  'POST /api/replies/bulk-suppress-check',
  'POST /api/scoring/learn',
  'POST /api/scoring/preview',
  'POST /api/scoring/recompute-all',
  'POST /api/segments',
  'POST /api/segments/:id/rebuild',
  'POST /api/segments/preview',
  'POST /api/suppression',
  'POST /api/suppressions',
  'POST /api/suppressions/domain',
  'POST /api/templates',
  'POST /api/templates/preview',
  'POST /api/vehicles',
  'POST /api/verify-loop/pause',
  'POST /api/verify-loop/resume',
  'POST /api/verify-loop/trigger',
  'PUT /api/campaigns/:id/pacing',
  'PUT /api/campaigns/:id/send-window',
  'PUT /api/campaigns/:id/sequence',
  'PUT /api/contacts/verify/config',
  'PUT /api/operator-settings/:key',
  'PUT /api/operator-settings/high-risk-domains',
  'PUT /api/scoring/config',
  'PUT /api/templates/:id',
]

describe('BFF route inventory', () => {
  describe('aggregate shape', () => {
    it('collects at least 100 routes', () => {
      expect(routes.length).toBeGreaterThanOrEqual(100)
    })
    it('collects at most 350 routes (sanity ceiling)', () => {
      // v2 unification (feat/dashboard-unification-v2) doubled the route surface:
      // vehicles, icp-sectors, verify-loop, relay, notifications, mailbox
      // reputation/delivery stats, etc. Ceiling raised from 200→350.
      // Current unique count: ~297. Headroom: 53 before this trips.
      expect(routes.length).toBeLessThanOrEqual(350)
    })
    it('every route string is sanitized (no spaces in path)', () => {
      for (const r of routes) {
        expect(r.path).not.toMatch(/\s/)
      }
    })
    it('every route uses an allowed HTTP method', () => {
      const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
      for (const r of routes) expect(allowed.has(r.method)).toBe(true)
    })
    it('every route path starts with /api/ (allowlist for public hooks)', () => {
      // Public, non-/api/ endpoints are deliberately excluded:
      //   /unsubscribe — GDPR self-service unsub link in email footers (BF-S0).
      //                  Must be public + token-gated; can't sit under /api/
      //                  or it'd require API-key auth.
      //   /sentry-tunnel — Sentry browser SDK tunnel (ad-blocker bypass).
      //                    Sentry envelope POSTs by spec land at site root.
      //   /privacy — public privacy notice (referenced from email footers per
      //              KT-A2 templates). Must NOT require API key — recipients
      //              of B2B outreach must be able to read GDPR notice without
      //              auth (would otherwise be GDPR violation).
      const PUBLIC_NON_API = new Set(['/unsubscribe', '/sentry-tunnel', '/privacy'])
      for (const r of routes) {
        if (PUBLIC_NON_API.has(r.path)) continue
        expect(r.path.startsWith('/api/')).toBe(true)
      }
    })
    it('no route path ends with a trailing slash', () => {
      for (const r of routes) expect(r.path.endsWith('/')).toBe(false)
    })
    it('no route path contains a double slash', () => {
      for (const r of routes) expect(r.path.includes('//')).toBe(false)
    })
    it('param names are lowercase with optional dashes', () => {
      for (const r of routes) {
        const params = r.path.match(/:[a-zA-Z0-9_]+/g) ?? []
        for (const p of params) expect(p).toMatch(/^:[a-z][a-zA-Z0-9]*$/)
      }
    })
  })

  describe('per-method counts', () => {
    const count = (m: string) =>
      uniqKeys.filter((k) => k.startsWith(m + ' ')).length
    it('has at least 40 GET routes', () => {
      expect(count('GET')).toBeGreaterThanOrEqual(40)
    })
    it('has at least 20 POST routes', () => {
      expect(count('POST')).toBeGreaterThanOrEqual(20)
    })
    it('has at least 5 PATCH routes', () => {
      expect(count('PATCH')).toBeGreaterThanOrEqual(5)
    })
    it('has at least 5 DELETE routes', () => {
      expect(count('DELETE')).toBeGreaterThanOrEqual(5)
    })
    it('has at least 1 PUT route', () => {
      expect(count('PUT')).toBeGreaterThanOrEqual(1)
    })
  })

  describe('canonical snapshot', () => {
    it('expected list is sorted and unique', () => {
      const sortedCopy = [...EXPECTED_ROUTES].sort()
      expect(EXPECTED_ROUTES).toEqual(sortedCopy)
      expect(new Set(EXPECTED_ROUTES).size).toBe(EXPECTED_ROUTES.length)
    })
    it('collected routes are a superset of expected', () => {
      const present = new Set(uniqKeys)
      for (const e of EXPECTED_ROUTES) expect(present.has(e)).toBe(true)
    })
    it('no surprise routes beyond expected', () => {
      const expected = new Set(EXPECTED_ROUTES)
      const extra = uniqKeys.filter((k) => !expected.has(k))
      expect(extra).toEqual([])
    })
  })

  describe('route family coverage', () => {
    const families: [string, RegExp][] = [
      ['companies', /^\/api\/companies(\/|$)/],
      ['campaigns', /^\/api\/campaigns(\/|$)/],
      ['mailboxes', /^\/api\/mailboxes(\/|$)/],
      ['segments', /^\/api\/segments(\/|$)/],
      ['templates', /^\/api\/templates(\/|$)/],
      ['scoring', /^\/api\/scoring(\/|$)/],
      ['meta', /^\/api\/meta(\/|$)/],
      ['health', /^\/api\/health(\/|$)/],
      ['analytics', /^\/api\/analytics(\/|$)/],
      ['replies', /^\/api\/replies(\/|$)/],
      ['categories', /^\/api\/categories(\/|$)/],
      ['diagnostics', /^\/api\/diagnostics(\/|$)/],
    ]
    for (const [name, rx] of families) {
      it(`family "${name}" has at least one route`, () => {
        const matched = routes.filter((r) => rx.test(r.path))
        expect(matched.length).toBeGreaterThan(0)
      })
    }
  })

  describe('no duplicate (method, path)', () => {
    it('distinct routes equal collected routes', () => {
      const set = new Set(keys)
      // Known duplicates (accepted historically — last registration wins):
      //   1× '/api/health/watchdog' GET in server.js (legacy + new handler)
      //   2× routes in src/routes/replies.js that overlap with server.js
      //      handlers from before extraction (intentional — kept on both
      //      sides during gradual migration; will be removed once all
      //      callers point at router exclusively)
      // Allow up to 3 known collisions; new collisions must justify a bump.
      const dupes = keys.length - set.size
      expect(dupes).toBeLessThanOrEqual(3)
    })
  })
})
