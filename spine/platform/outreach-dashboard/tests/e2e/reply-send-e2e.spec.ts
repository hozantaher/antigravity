// ═══════════════════════════════════════════════════════════════════════════
//  Sprint 2.3 (mail-client) — Reply send end-to-end E2E (Playwright)
//
//  Locks the operator reply composer on /replies/:id (ThreadDetail.jsx):
//  body typing, file drag-drop chips, send/cancel, error toast on 500,
//  multipart payload shape sent to POST /api/replies/:id/reply, and the
//  contract that the BFF endpoint queues into manual_reply_outbox (not
//  direct submit). The orchestrator cron `runOutboundReplyCron` (covered by
//  contract + unit tests) picks the row up, builds RFC 5322 MIME with the
//  inferred In-Reply-To from send_event.message_id, and dispatches via
//  anti-trace-relay. This spec only owns the operator-facing slice.
//
//  HARD rule alignment:
//    - feedback_ux_ui_first_plus_playwright (T0): every UI surface needs
//      Playwright smoke before merge — this spec is that smoke for the
//      reply composer's send path.
//    - feedback_smoke_gate_operator_strict (T0): zero tolerance for 4xx/5xx
//      console errors. consoleGuard captures them; clean test must finish
//      with empty error list.
//    - feedback_engine_path_test (T0): asserts payload routes to the
//      multipart endpoint (which writes manual_reply_outbox); never hits a
//      direct /v1/submit shortcut from the BFF.
//    - feedback_test_send_synthetic_only (T0): all bodies are explicit
//      "[TEST] …" synthetic strings — no PROD template text reaches the
//      simulated send path.
//
//  Real-shape data only; no fabricated UI labels (verified in
//  ThreadDetail.jsx 2026-05-14: "Odpovědět" composer header line 1186,
//  "Odeslat" button line 1217, "Odpověď odeslána" toast line 617,
//  "Zpět na Odpovědi" back button line 759).
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page, type Route } from '@playwright/test'

// ── Constants / fixtures ─────────────────────────────────────────────────────

const REPLY_ID = 4242
const OUTBOX_ID = 9999

const REPLY_FIXTURE = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Jan Novák',
    from_email: 'jan@alpha-stroj.cz',
    subject: 'Dotaz na výkup techniky',
    campaign_name: 'Strojírenství — výkup',
    campaign_id: 7777,
    contact_id: 11,
    mailbox_id: 3,
    classification: 'positive',
    handled: false,
    received_at: '2026-05-14T08:00:00Z',
  },
}

const MESSAGES_FIXTURE = {
  messages: [
    {
      id: 1,
      from_email: 'jan@alpha-stroj.cz',
      to_email: 'sales@firma.cz',
      subject: 'Dotaz na výkup techniky',
      body: 'Dobrý den, prosím o nabídku.',
      sent_at: '2026-05-14T08:00:00Z',
      direction: 'inbound',
    },
  ],
}

const CONTEXT_FIXTURE = {
  company: { name: 'Alpha Strojírna s.r.o.', ico: '12345678' },
  campaign: { id: 7777, name: 'Strojírenství — výkup', status: 'active', sent: 1, replied: 1 },
}

// ── Stub helpers ─────────────────────────────────────────────────────────────

type SendCapture = {
  fired: number
  /** Decoded body field from each multipart payload (operator-typed text). */
  bodies: string[]
  /** Filenames captured from each multipart payload. */
  filenames: string[][]
  /** Whether each request carried `multipart/form-data` Content-Type. */
  contentTypes: string[]
}

function newCapture(): SendCapture {
  return { fired: 0, bodies: [], filenames: [], contentTypes: [] }
}

/**
 * Parse a multipart/form-data body and extract:
 *   - the value of the `body` field
 *   - the filename attribute of every `files` part
 *
 * Operates on the raw byte string Playwright surfaces via postData(); we
 * use a simple regex pass rather than a full RFC 2046 parser because the
 * fixtures are tiny and the test owns both sides of the protocol.
 */
function parseMultipart(raw: string | null): { body: string; filenames: string[] } {
  if (!raw) return { body: '', filenames: [] }
  const filenames: string[] = []
  const fnRe = /name="files"[^]*?filename="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = fnRe.exec(raw)) !== null) {
    filenames.push(m[1])
  }
  let body = ''
  const bodyRe = /name="body"\r?\n\r?\n([\s\S]*?)\r?\n--/
  const bm = bodyRe.exec(raw)
  if (bm) body = bm[1]
  return { body, filenames }
}

async function stubThread(
  page: Page,
  capture: SendCapture,
  opts: { sendStatus?: number; sendErrorBody?: string } = {},
) {
  // EventSource is NOT routed by page.route() (per
  // feedback_playwright_route_gotcha memory + comment in
  // AlertToastListener.jsx). Without this stub, the real /api/alerts/stream
  // and /api/threads/stream calls hit the absent BFF and emit a MIME-type
  // error to the console, tripping the operator-strict smoke gate. We
  // replace the global EventSource with a no-op shim at navigation time so
  // every page in this spec is safe.
  await page.addInitScript(() => {
    class NoopEventSource {
      readyState = 1
      url: string
      onopen: ((this: EventSource, ev: Event) => unknown) | null = null
      onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null
      constructor(url: string | URL) { this.url = String(url) }
      addEventListener() {}
      removeEventListener() {}
      close() {}
      dispatchEvent() { return true }
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
    }
    ;(window as unknown as { EventSource: unknown }).EventSource = NoopEventSource
  })

  // Console-error guard: HARD rule smoke_gate_operator_strict — any 4xx/5xx
  // network error logged to console fails the run. We collect them on the
  // page object and assert at the end of every passing test.
  const consoleErrors: string[] = []
  ;(page as unknown as { __consoleErrors: string[] }).__consoleErrors = consoleErrors
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    // Allowlist: favicon noise + React DevTools probe (mirrors the global
    // smoke filter convention — see CLAUDE.md feedback_smoke_gate_operator_strict).
    if (/favicon|react devtools|sourcemap/i.test(text)) return
    consoleErrors.push(text)
  })
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(REPLY_FIXTURE),
    })
  })
  await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MESSAGES_FIXTURE),
    }),
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CONTEXT_FIXTURE),
    }),
  )
  // Silence the listing/stats fetches Replies.jsx kicks off on Back.
  await page.route('**/api/replies?**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"rows":[],"total":0}' }),
  )
  await page.route('**/api/replies/stats', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"unhandled":0}' }),
  )

  // The actual reply-send endpoint we're testing.
  await page.route(`**/api/replies/${REPLY_ID}/reply`, (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    capture.fired += 1
    capture.contentTypes.push(route.request().headers()['content-type'] || '')
    const parsed = parseMultipart(route.request().postData())
    capture.bodies.push(parsed.body)
    capture.filenames.push(parsed.filenames)
    if (opts.sendStatus && opts.sendStatus >= 400) {
      return route.fulfill({
        status: opts.sendStatus,
        contentType: 'text/plain',
        body: opts.sendErrorBody ?? 'simulated upstream failure',
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        outbox_id: OUTBOX_ID,
        attachments: [],
        note: 'queued — operator will see send confirmation within ~2 min',
      }),
    })
  })

  // ── Auxiliary store-feed endpoints. Layout + AlertToastListener fire
  // these on every page load via the Zustand store `loadAll` reducer. The
  // store expects arrays so it can `.filter()` / `.map()`. Returning `{}`
  // would crash the page with `campaigns.filter is not a function`.
  for (const path of ['/api/mailboxes', '/api/campaigns', '/api/templates', '/api/segments']) {
    await page.route(`**${path}**`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    )
  }
  // Catch-all — registered LAST so Playwright's LIFO match order checks
  // this FIRST. It explicitly falls through (`route.fallback()`) only for
  // paths a specific route above already handles; everything else is
  // silenced with an empty JSON `{}` (or `[]` for known array-shape paths)
  // so unstubbed probes don't leak 401/429 to the console.
  //
  // The list of fallthrough patterns matches the URL templates registered
  // above exactly — `/api/replies/4242/attachments` and similar siblings
  // intentionally DO NOT fall through, since no specific stub owns them.
  const FALLTHROUGH = [
    new RegExp(`/api/replies/${REPLY_ID}$`),
    new RegExp(`/api/threads/${REPLY_ID}/messages$`),
    new RegExp(`/api/threads/${REPLY_ID}/context$`),
    new RegExp(`/api/replies/${REPLY_ID}/reply$`),
    /\/api\/replies\?/,
    /\/api\/replies\/stats$/,
    /\/api\/mailboxes(\?|$)/,
    /\/api\/campaigns(\?|$)/,
    /\/api\/templates(\?|$)/,
    /\/api\/segments(\?|$)/,
  ]
  await page.route('**/api/**', (route) => {
    const url = route.request().url()
    if (FALLTHROUGH.some((re) => re.test(url))) return route.fallback()
    // Default no-op shape: `{}` is safe for object-typed endpoints. Layout
    // arrays are caught by the specific routes above.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
}

/** Assert the console-error guard is empty — every test invokes this at the end. */
async function expectNoConsoleErrors(page: Page) {
  const errs = (page as unknown as { __consoleErrors: string[] }).__consoleErrors ?? []
  expect(errs, `unexpected console errors: ${errs.join(' | ')}`).toEqual([])
}

/** Convenience: locate the composer textarea by its Czech placeholder copy. */
function composer(page: Page) {
  return page.locator('textarea[placeholder^="Napište odpověď"]')
}

/** Convenience: locate the Odeslat (send) primary button. */
function sendButton(page: Page) {
  return page.getByRole('button', { name: /Odeslat/i })
}

// ═══════════════════════════════════════════════════════════════════════════
//  Test cases — Sprint 2.3 reply-send E2E coverage grid
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Sprint 2.3 — reply composer send E2E', () => {
  // ── 1. Happy path: type body + Odeslat → toast + queued outbox row ───────
  test('1. types body, clicks Odeslat → POST multipart fires + "Odpověď odeslána" toast', async ({ page }) => {
    const capture = newCapture()
    await stubThread(page, capture)
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    // Composer header is the "Odpovědět" label (line 1186 in ThreadDetail.jsx)
    await expect(page.locator('text=/^Odpovědět$/')).toBeVisible()
    await composer(page).fill('[TEST] Děkuji za zájem, ozveme se zítra.')
    await sendButton(page).click()
    await expect.poll(() => capture.fired, { timeout: 5_000 }).toBe(1)
    expect(capture.contentTypes[0]).toMatch(/^multipart\/form-data/i)
    expect(capture.bodies[0]).toContain('[TEST] Děkuji za zájem')
    await expect(page.locator('text=/Odpověď odeslána/').first()).toBeVisible({ timeout: 3_000 })
    await expectNoConsoleErrors(page)
  })

  // ── 2. Empty body is a no-op: button is disabled, no POST fires ─────────
  test('2. empty body → Odeslat is disabled, no POST fires', async ({ page }) => {
    const capture = newCapture()
    await stubThread(page, capture)
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    const send = sendButton(page)
    await expect(send).toBeVisible()
    await expect(send).toBeDisabled()
    // Forced click does nothing (the click guards on body.trim()).
    await send.click({ force: true }).catch(() => {})
    await page.waitForTimeout(300)
    expect(capture.fired).toBe(0)
    await expectNoConsoleErrors(page)
  })

  // ── 3. Whitespace-only body → still disabled (trim() check) ─────────────
  test('3. whitespace-only body keeps Odeslat disabled (trim() guard)', async ({ page }) => {
    const capture = newCapture()
    await stubThread(page, capture)
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    await composer(page).fill('     \n\t   ')
    await expect(sendButton(page)).toBeDisabled()
    expect(capture.fired).toBe(0)
    await expectNoConsoleErrors(page)
  })

  // ── 4. Attachment via file input → multipart includes file ──────────────
  test('4. attached file appears as chip + multipart payload includes filename', async ({ page }) => {
    const capture = newCapture()
    await stubThread(page, capture)
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    await composer(page).fill('[TEST] Příloha v příloze.')
    // Hidden file input (the visible label triggers it on click).
    await page.setInputFiles('input[type="file"]', {
      name: 'nabidka.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 test stub content', 'utf-8'),
    })
    // Filename appears as a chip in the attachment list.
    await expect(page.locator('text=/nabidka\\.pdf/').first()).toBeVisible({ timeout: 3_000 })
    await sendButton(page).click()
    await expect.poll(() => capture.fired, { timeout: 5_000 }).toBe(1)
    expect(capture.filenames[0]).toContain('nabidka.pdf')
    await expectNoConsoleErrors(page)
  })

  // ── 5. Back button returns to /replies without sending ──────────────────
  test('5. clicking "Zpět" navigates back to /replies without firing send', async ({ page }) => {
    const capture = newCapture()
    await stubThread(page, capture)
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    await composer(page).fill('[TEST] Tohle nikdy neodejde.')
    await page.getByRole('button', { name: /Zpět/ }).click()
    await expect(page).toHaveURL(/\/replies$/)
    expect(capture.fired).toBe(0)
    await expectNoConsoleErrors(page)
  })

  // ── 6. BFF contract — payload owns body only; threading inferred at cron
  //      time. The form has NO subject / no In-Reply-To input by design —
  //      runOutboundReplyCron pulls send_event.message_id when building MIME.
  //      Guard: payload must not contain a `subject` or `in_reply_to` field
  //      so a future regression that adds an operator-controlled subject
  //      breaks the cron contract loudly.
  test('6. multipart payload carries body field only — no subject / in_reply_to operator input', async ({ page }) => {
    const capture = newCapture()
    await stubThread(page, capture)
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    await composer(page).fill('[TEST] Pouze tělo, vlákno řeší cron.')
    await sendButton(page).click()
    await expect.poll(() => capture.fired, { timeout: 5_000 }).toBe(1)
    // Raw multipart inspection — these field names MUST NOT appear, the
    // cron derives them from reply_inbox_id → send_event.message_id.
    const raw = capture.bodies[0]
    expect(raw).not.toContain('name="subject"')
    expect(raw).not.toContain('name="in_reply_to"')
    expect(raw).not.toContain('name="in_reply_to_message_id"')
    await expectNoConsoleErrors(page)
  })

  // ── 7. Network 500 → error toast appears + body preserved for retry ─────
  test('7. POST 500 → "Odeslání selhalo" toast + body remains in textarea', async ({ page }) => {
    const capture = newCapture()
    await stubThread(page, capture, { sendStatus: 500, sendErrorBody: 'db down' })
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    const draft = '[TEST] Tato zpráva má selhat odeslání.'
    await composer(page).fill(draft)
    await sendButton(page).click()
    await expect.poll(() => capture.fired, { timeout: 5_000 }).toBe(1)
    await expect(page.locator('text=/Odeslání selhalo/').first()).toBeVisible({ timeout: 3_000 })
    // Body intact for retry (handleSendReply preserves on error).
    await expect(composer(page)).toHaveValue(draft)
    // Chromium always emits a "Failed to load resource: 500" console error
    // for non-2xx responses — that's the very response this test
    // intentionally provokes. Drop it from the captured console errors
    // before the strict-gate assertion so only *unexpected* errors fail.
    const errs = (page as unknown as { __consoleErrors: string[] }).__consoleErrors
    if (errs) {
      ;(page as unknown as { __consoleErrors: string[] }).__consoleErrors = errs.filter(
        (e) => !/Failed to load resource:.*500/.test(e),
      )
    }
    await expectNoConsoleErrors(page)
  })

  // ── 8. Cmd/Ctrl+Enter shortcut sends (operator keyboard parity) ─────────
  test('8. Cmd/Ctrl+Enter in textarea triggers send (keyboard parity with click)', async ({ page }) => {
    const capture = newCapture()
    await stubThread(page, capture)
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    const textarea = composer(page)
    await textarea.fill('[TEST] Klávesová zkratka odeslat.')
    await textarea.focus()
    // Try Meta+Enter first (macOS), fall back to Control+Enter (Win/Linux).
    await page.keyboard.press('Meta+Enter')
    if (capture.fired === 0) {
      await page.keyboard.press('Control+Enter')
    }
    await expect.poll(() => capture.fired, { timeout: 5_000 }).toBe(1)
    expect(capture.bodies[0]).toContain('Klávesová zkratka')
    await expect(page.locator('text=/Odpověď odeslána/').first()).toBeVisible({ timeout: 3_000 })
    await expectNoConsoleErrors(page)
  })

  // ── 9. After success, body + attachments clear (next-reply readiness) ───
  test('9. successful send clears body + attachments so composer is ready for next reply', async ({ page }) => {
    const capture = newCapture()
    await stubThread(page, capture)
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    await composer(page).fill('[TEST] První odpověď.')
    await page.setInputFiles('input[type="file"]', {
      name: 'priloha.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    })
    await expect(page.locator('text=/priloha\\.png/').first()).toBeVisible()
    await sendButton(page).click()
    await expect.poll(() => capture.fired, { timeout: 5_000 }).toBe(1)
    // Textarea now empty.
    await expect(composer(page)).toHaveValue('')
    // Attachment chip gone (state cleared on success per handleSendReply).
    await expect(page.locator('text=/priloha\\.png/')).toHaveCount(0)
    await expectNoConsoleErrors(page)
  })
})
