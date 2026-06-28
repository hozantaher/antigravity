import { test, expect } from '@playwright/test'
import { classifyRequest, createLedger } from './safety-guard'

const APP = 'https://outreach.auction24.cz'

// ── Things that MUST be blocked as mutations (sends / writes / destructive) ──
const MUST_BLOCK_MUTATION: Array<[string, string]> = [
  ['POST', `${APP}/api/campaigns/457/run`],            // launch campaign → REAL SMTP
  ['POST', `${APP}/api/campaigns/457/send-batch`],     // send a batch
  ['POST', `${APP}/api/campaigns/457/send-test`],      // test send
  ['POST', `${APP}/api/mailboxes/12/send-test`],       // mailbox test send
  ['POST', `${APP}/api/mailboxes/12/pipeline-test`],   // full pipeline send
  ['POST', `${APP}/api/replies/88/reply`],             // reply to a real prospect
  ['POST', `${APP}/api/replies/88/forward-to-crm`],
  ['POST', `${APP}/api/campaigns/pause-all`],          // disruptive
  ['POST', `${APP}/api/operator/rotate-api-key`],      // would break prod
  ['POST', `${APP}/api/dsr/erase`],                    // GDPR destructive
  ['POST', `${APP}/api/contacts/5/verify-email`],      // external SMTP probe
  ['POST', `${APP}/api/companies/abc/verify-email`],
  ['POST', `${APP}/api/anonymity/run`],
  ['POST', `${APP}/api/mailboxes/12/diagnose`],
  ['POST', `${APP}/api/mailboxes/12/recover`],
  ['PATCH', `${APP}/api/campaigns/457`],               // edit campaign
  ['PATCH', `${APP}/api/replies/88/handled`],          // triage state change
  ['PATCH', `${APP}/api/mailboxes/12/status`],
  ['PUT', `${APP}/api/operator-settings/daily_cap`],   // changes send behaviour
  ['PUT', `${APP}/api/campaigns/457/pacing`],
  ['DELETE', `${APP}/api/campaigns/457`],
  ['DELETE', `${APP}/api/contacts/5`],
  ['POST', `${APP}/api/templates`],                    // creates prod row
  ['POST', `${APP}/api/segments/9/rebuild`],
]

// ── GET probes that hit real mail servers (block despite GET) ────────────────
const MUST_BLOCK_PROBE: Array<[string, string]> = [
  ['GET', `${APP}/api/mailboxes/12/smtp-check`],
  ['GET', `${APP}/api/mailboxes/12/imap-check`],
  ['GET', `${APP}/api/mailboxes/12/full-check`],
  ['GET', `${APP}/api/mailboxes/12/imap-inbox`],
]

// ── Things that MUST be allowed (read-only data loads + infra) ───────────────
const MUST_ALLOW: Array<[string, string]> = [
  ['GET', `${APP}/api/campaigns`],
  ['GET', `${APP}/api/campaigns/457`],
  ['GET', `${APP}/api/replies?handled=false`],
  ['GET', `${APP}/api/vehicles`],
  ['GET', `${APP}/api/mailboxes`],
  ['GET', `${APP}/api/dashboard/summary`],
  ['GET', `${APP}/api/analytics/overview`],
  ['GET', `${APP}/schranky`],
  ['GET', `${APP}/assets/index-abc123.js`],
  // Firebase auth + token refresh (login must work):
  ['POST', 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=x'],
  ['POST', 'https://securetoken.googleapis.com/v1/token?key=x'],
  ['POST', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=x'],
  // Fonts / telemetry:
  ['GET', 'https://fonts.googleapis.com/css2?family=x'],
  ['GET', 'https://fonts.gstatic.com/s/x.woff2'],
]

test.describe('safety-guard classifier (offline — no prod contact)', () => {
  for (const [method, url] of MUST_BLOCK_MUTATION) {
    test(`BLOCK mutation: ${method} ${url.replace(APP, '')}`, () => {
      expect(classifyRequest(method, url)).toBe('block-mutation')
    })
  }

  for (const [method, url] of MUST_BLOCK_PROBE) {
    test(`BLOCK probe: ${method} ${url.replace(APP, '')}`, () => {
      expect(classifyRequest(method, url)).toBe('block-probe')
    })
  }

  for (const [method, url] of MUST_ALLOW) {
    test(`ALLOW: ${method} ${url.slice(0, 60)}`, () => {
      expect(classifyRequest(method, url)).toBe('allow')
    })
  }

  test('ledger records blocked + summarises', () => {
    const led = createLedger()
    led.entries.push({ ts: 1, method: 'POST', url: `${APP}/api/campaigns/1/run`, verdict: 'block-mutation' })
    led.entries.push({ ts: 2, method: 'GET', url: `${APP}/api/campaigns`, verdict: 'allow' })
    expect(led.blocked()).toHaveLength(1)
    expect(led.summary()).toContain('1 dangerous request')
    expect(led.summary()).toContain('campaigns/1/run')
  })

  test('regression: no Tier-1 send endpoint is ever classified allow', () => {
    const sends = ['/run', '/send-batch', '/send-test', '/reply', '/pipeline-test']
    for (const s of sends) {
      expect(classifyRequest('POST', `${APP}/api/x${s}`)).not.toBe('allow')
    }
  })
})
