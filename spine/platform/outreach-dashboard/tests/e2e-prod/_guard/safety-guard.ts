// ============================================================================
// PRODUCTION E2E SAFETY KILL-SWITCH
// ============================================================================
// These E2E specs run against the LIVE production dashboard
// (https://outreach.auction24.cz). In production the BFF runs with
// BFF_AUTH_DISABLED=1 and talks DIRECTLY to PROD Postgres + the Go sender
// daemon + the anti-trace relay. That means a single mis-click on "Spustit
// kampaň" / "Odeslat" / a mailbox probe could send REAL email to REAL
// business recipients or hammer real mail servers.
//
// The app's own auth gate is frontend-only, so it cannot protect us. The ONLY
// reliable guard is at the browser network layer: we intercept every request
// the page makes and ABORT anything that could mutate prod state, send mail,
// or perform external I/O — before it ever leaves the browser.
//
// Default posture: DENY. We allow:
//   - GET/HEAD/OPTIONS to the BFF (read-only data loads)            — EXCEPT probe GETs
//   - requests to Firebase auth / Google Fonts / Sentry (infra)
// We block:
//   - every POST/PUT/PATCH/DELETE to /api/*  (sends, launches, writes, key rotation, GDPR erase…)
//   - the external-I/O probe GETs (smtp-check / imap-check / full-check / imap-inbox)
//
// Every blocked request is recorded in an audit ledger so the run can PROVE
// that nothing dangerous ever reached the network.
// ============================================================================

import type { Page, Route, Request } from '@playwright/test'

export type Verdict = 'allow' | 'block-mutation' | 'block-probe'

export interface LedgerEntry {
  ts: number
  method: string
  url: string
  verdict: Verdict
}

export interface SafetyLedger {
  entries: LedgerEntry[]
  blocked(): LedgerEntry[]
  allowedMutations(): LedgerEntry[]
  summary(): string
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Hosts that are infrastructure (auth / fonts / telemetry) and must NEVER be
// blocked, even if their path happens to contain "/api/".
const ALWAYS_ALLOW_HOST = [
  /(^|\.)googleapis\.com$/i, // identitytoolkit, securetoken, fonts
  /(^|\.)gstatic\.com$/i,
  /(^|\.)firebaseapp\.com$/i,
  /(^|\.)firebaseio\.com$/i,
  /(^|\.)google\.com$/i,
  /(^|\.)sentry\.io$/i,
  /ingest\.(de\.)?sentry\.io$/i,
]

// GET endpoints that LOOK like reads but trigger external network I/O against
// real mail servers (SMTP/IMAP dials). Blocked despite being GET.
const DANGEROUS_GET = [
  /\/api\/mailboxes\/[^/?]+\/(smtp-check|imap-check|full-check|imap-inbox)\b/i,
]

// Read-style POSTs that are provably side-effect-free (pure preview/compute,
// no send, no external I/O, no DB write). Kept INTENTIONALLY EMPTY so the
// default is total lock-down. Add here ONLY with a justification comment if a
// page genuinely needs one to render, and only after confirming it is read-only.
const SAFE_MUTATIONS: RegExp[] = [
  // (none — fully locked down)
]

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * Pure classifier — no I/O, unit-testable. Decides the fate of one request.
 */
export function classifyRequest(method: string, url: string): Verdict {
  const m = (method || 'GET').toUpperCase()
  const host = hostOf(url)

  // 1. Infra hosts (Firebase auth, fonts, Sentry) — always allow.
  if (host && ALWAYS_ALLOW_HOST.some((re) => re.test(host))) return 'allow'

  // 2. External-I/O probe GETs — block even though they are GET.
  if (DANGEROUS_GET.some((re) => re.test(url))) return 'block-probe'

  // 3. Any mutation against the BFF API — block unless explicitly safe-listed.
  if (/\/api\//.test(url) && !SAFE_METHODS.has(m)) {
    if (SAFE_MUTATIONS.some((re) => re.test(url))) return 'allow'
    return 'block-mutation'
  }

  // 4. Everything else (read-only GET data loads, static assets, fonts) — allow.
  return 'allow'
}

export function createLedger(): SafetyLedger {
  const entries: LedgerEntry[] = []
  return {
    entries,
    blocked: () => entries.filter((e) => e.verdict !== 'allow'),
    allowedMutations: () =>
      entries.filter(
        (e) => e.verdict === 'allow' && !SAFE_METHODS.has(e.method.toUpperCase()) && /\/api\//.test(e.url),
      ),
    summary() {
      const b = this.blocked()
      const lines = [
        `Safety ledger: ${b.length} dangerous request(s) intercepted & aborted.`,
        ...b.map((e) => `  ✗ ABORTED [${e.verdict}] ${e.method} ${e.url}`),
      ]
      const am = this.allowedMutations()
      if (am.length) lines.push(...am.map((e) => `  ⚠ ALLOWED-MUTATION ${e.method} ${e.url}`))
      return lines.join('\n')
    },
  }
}

/**
 * Install the kill-switch on a Playwright page. Records every request to the
 * ledger and aborts anything dangerous. Must be called BEFORE navigation.
 */
export async function installSafetyGuard(page: Page, ledger: SafetyLedger): Promise<void> {
  await page.route('**/*', (route: Route, request: Request) => {
    const url = request.url()
    const method = request.method()
    const verdict = classifyRequest(method, url)
    // Only ledger API-relevant or blocked requests (avoid noise from fonts/assets).
    if (verdict !== 'allow' || (/\/api\//.test(url) && !SAFE_METHODS.has(method.toUpperCase()))) {
      ledger.entries.push({ ts: Date.now(), method, url, verdict })
    }
    if (verdict === 'allow') return route.continue()
    // Abort dangerous requests with a connection-failed so the app surfaces a
    // benign network error rather than a misleading HTTP status.
    return route.abort('failed')
  })
}
