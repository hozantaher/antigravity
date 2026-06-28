// ═══════════════════════════════════════════════════════════════════════════
//  AV-F3 — Vehicle extractor pre-fill smoke
//
// Goto /replies/<id> with stubbed reply context + mocked
// /api/replies/:id/extracted-vehicles returning 3 confident candidates.
// Open the Zapsat vozidlo modal and assert:
//   - The "AI rozpoznal" banner mounts with vehicle count copy.
//   - The dropdown lists each candidate.
//   - Selecting a candidate auto-fills make / model / year fields.
//   - "Vyplnit ručně" clears the form.
//   - Page renders without 4xx/5xx console errors (strict gate per
//     HARD rule `feedback_smoke_gate_operator_strict`).
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

const REPLY_ID = 5901
const NOW = Date.now()

const REPLY_PAYLOAD = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Petr Novák',
    from_email: 'novak@strojeczech.cz',
    subject: 'Re: nabídka strojů',
    campaign_name: 'Výkup techniky',
    classification: 'positive',
    handled: false,
    received_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
    body_preview:
      'Kolový bagr HITACHI 160W r.v. 2015, 8500 mth. Komatsu PC 160LC.',
  },
}

const CONTEXT_PAYLOAD = {
  company: { name: 'Stroje Czech s.r.o.', ico: '87654321' },
  contact: { name: 'Petr Novák', email: 'novak@strojeczech.cz' },
  campaign: { id: 7, name: 'Výkup techniky', status: 'running' },
}

const MESSAGES_PAYLOAD = {
  messages: [
    {
      id: 1,
      type: 'incoming',
      sender: 'novak@strojeczech.cz',
      sender_name: 'Petr Novák',
      sent_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
      body: 'Kolový bagr HITACHI 160W r.v. 2015, 8500 mth. Komatsu PC 160LC.',
    },
  ],
}

// Three confident extracted vehicles — all above the 0.60 floor so they
// surface in the banner dropdown.
const EXTRACTED_PAYLOAD = {
  vehicles: [
    {
      make: 'Hitachi',
      model: '160W',
      year: 2015,
      mileage_km: null,
      motohours: 8500,
      price_offered_eur: null,
      body_type: 'kolový bagr',
      confidence: 0.9,
      matched_text: 'Kolový bagr HITACHI 160W r.v. 2015, 8500 mth',
      matched_patterns: ['brand', 'model', 'year', 'motohours', 'body_type'],
    },
    {
      make: 'Komatsu',
      model: 'PC160LC',
      year: null,
      mileage_km: null,
      motohours: null,
      price_offered_eur: null,
      body_type: null,
      confidence: 0.7,
      matched_text: 'Komatsu PC 160LC',
      matched_patterns: ['brand', 'model'],
    },
    {
      make: 'Liebherr',
      model: '922',
      year: null,
      mileage_km: null,
      motohours: 1850,
      price_offered_eur: null,
      body_type: 'bagr',
      confidence: 0.8,
      matched_text: 'Liebherr 922 1850 mth',
      matched_patterns: ['brand', 'model', 'motohours', 'body_type'],
    },
  ],
  extractor_version: 'regex_v1',
  cached_at: new Date().toISOString(),
  cache_hit: false,
}

async function stubThread(page: Page) {
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(REPLY_PAYLOAD),
    })
  })
  await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MESSAGES_PAYLOAD),
    })
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CONTEXT_PAYLOAD),
    })
  )
  await page.route(`**/api/replies/${REPLY_ID}/attachments`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"attachments":[]}',
    })
  )
  await page.route(`**/api/replies/${REPLY_ID}/extracted-vehicles`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EXTRACTED_PAYLOAD),
    })
  )
}

function isHarmlessConsoleNoise(msg: ConsoleMessage): boolean {
  const text = msg.text()
  if (msg.type() !== 'error' && msg.type() !== 'warning') return true
  if (/React DevTools/i.test(text)) return true
  if (/favicon/i.test(text)) return true
  if (/sourcemap/i.test(text)) return true
  if (/preloaded using link preload but not used/i.test(text)) return true
  return false
}

test.describe('AV-F3 — VehicleCaptureModal AI banner pre-fill', () => {
  test('banner mounts, dropdown lists extracted candidates, selection auto-fills form', async ({ page }) => {
    const consoleNoise: string[] = []
    page.on('console', (m) => {
      if (!isHarmlessConsoleNoise(m)) consoleNoise.push(`[${m.type()}] ${m.text()}`)
    })

    await stubThread(page)

    await page.goto(`/replies/${REPLY_ID}`)

    const captureBtn = page.getByTestId('capture-vehicle-btn')
    await expect(captureBtn).toBeVisible({ timeout: 10_000 })
    await captureBtn.click()

    // Modal mounts with provenance.
    await expect(page.getByTestId('vehicle-capture-modal')).toBeVisible()

    // AI banner appears (3 confident candidates → "3 vozidla" copy).
    const banner = page.getByTestId('vehicle-capture-extract-banner')
    await expect(banner).toBeVisible({ timeout: 5_000 })
    await expect(banner).toContainText(/AI rozpoznal/)
    await expect(banner).toContainText(/3/)

    // Dropdown is present + has the three candidate options.
    const select = page.getByTestId('vehicle-capture-extract-select')
    await expect(select).toBeVisible()
    // Verify each candidate option exists by data-testid.
    await expect(page.getByTestId('vehicle-capture-extract-option-0')).toHaveCount(1)
    await expect(page.getByTestId('vehicle-capture-extract-option-1')).toHaveCount(1)
    await expect(page.getByTestId('vehicle-capture-extract-option-2')).toHaveCount(1)

    // Pick the first option (Hitachi 160W 2015 8500h). Form should auto-fill.
    await select.selectOption('0')
    await expect(page.getByTestId('vehicle-capture-make')).toHaveValue('Hitachi')
    await expect(page.getByTestId('vehicle-capture-model')).toHaveValue('160W')
    await expect(page.getByTestId('vehicle-capture-year')).toHaveValue('2015')

    // Submit button enables once make + model are present.
    await expect(page.getByTestId('vehicle-capture-submit-btn')).toBeEnabled()

    // "Vyplnit ručně" clears the form.
    await select.selectOption('__manual__')
    await expect(page.getByTestId('vehicle-capture-make')).toHaveValue('')
    await expect(page.getByTestId('vehicle-capture-model')).toHaveValue('')
    await expect(page.getByTestId('vehicle-capture-year')).toHaveValue('')

    // Strict console gate.
    expect(
      consoleNoise,
      `Console noise observed:\n${consoleNoise.join('\n')}`
    ).toEqual([])
  })
})
