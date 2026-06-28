// ═══════════════════════════════════════════════════════════════════════════
//  AU-F3 — "Zapsat vozidlo" modal smoke
//
// Goto /replies/<id> with a stubbed reply context, click the new Truck
// button in ThreadActionDock, fill make + model + year, hit Zapsat vozidlo
// and verify:
//   - The modal opens with provenance pre-fill (Od / Firma / Z odpovědi).
//   - POST /api/vehicles is called with the documented payload shape.
//   - On 201 the page navigates to /vehicles/:newId (route may be a 404
//     stub until AU-F4 lands — that's fine, we only assert the URL).
//   - The page loads without 4xx/5xx console errors (strict gate per
//     HARD rule `feedback_smoke_gate_operator_strict`).
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

const REPLY_ID = 5527
const NEW_VEHICLE_ID = 9012
const NOW = Date.now()

const REPLY_PAYLOAD = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Petra Gerhátová',
    from_email: 'gerhatova@gevotransport.eu',
    subject: 'Re: výkup dodávky',
    campaign_name: 'Výkup techniky',
    classification: 'positive',
    handled: false,
    received_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
    body_preview: 'Máme dodávku. Je již prošlá technická.',
  },
}

const CONTEXT_PAYLOAD = {
  company: { name: 'GEVO TRANSPORT, s.r.o.', ico: '12345678' },
  contact: {
    name: 'Petra Gerhátová',
    email: 'gerhatova@gevotransport.eu',
  },
  campaign: { id: 7, name: 'Výkup techniky', status: 'running' },
}

const MESSAGES_PAYLOAD = {
  messages: [
    {
      id: 1,
      type: 'incoming',
      sender: 'gerhatova@gevotransport.eu',
      sender_name: 'Petra Gerhátová',
      sent_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
      body: 'Máme dodávku. Je již prošlá technická.',
    },
  ],
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MESSAGES_PAYLOAD) })
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONTEXT_PAYLOAD) })
  )
  await page.route(`**/api/replies/${REPLY_ID}/attachments`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"attachments":[]}' })
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

test.describe('AU-F3 — /replies/:id Zapsat vozidlo modal', () => {
  test('opens, pre-fills provenance, POSTs to /api/vehicles, navigates to new vehicle', async ({ page }) => {
    const consoleNoise: string[] = []
    page.on('console', (m) => {
      if (!isHarmlessConsoleNoise(m)) consoleNoise.push(`[${m.type()}] ${m.text()}`)
    })

    await stubThread(page)

    // Capture the POST body so we can assert payload shape.
    let postedBody: unknown = null
    await page.route('**/api/vehicles', (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      try {
        postedBody = JSON.parse(route.request().postData() || 'null')
      } catch {
        postedBody = null
      }
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: NEW_VEHICLE_ID, make: 'Mercedes', model: 'Sprinter' }),
      })
    })

    // /vehicles/:id is an AU-F4 follow-up. Stub a placeholder so navigation
    // doesn't 404 in the smoke environment.
    await page.route(`**/vehicles/${NEW_VEHICLE_ID}`, (route) => route.continue())

    await page.goto(`/replies/${REPLY_ID}`)

    // Wait for the dock to render (Truck button is the modal trigger).
    const captureBtn = page.getByTestId('capture-vehicle-btn')
    await expect(captureBtn).toBeVisible({ timeout: 10_000 })
    await expect(captureBtn).toHaveText(/Zapsat vozidlo/)

    await captureBtn.click()

    // Modal mounts with provenance pre-fill.
    await expect(page.getByTestId('vehicle-capture-modal')).toBeVisible()
    await expect(page.getByTestId('vehicle-capture-from')).toContainText('Petra Gerhátová')
    await expect(page.getByTestId('vehicle-capture-company')).toContainText('GEVO TRANSPORT')

    // Submit is disabled until make + model.
    const submit = page.getByTestId('vehicle-capture-submit-btn')
    await expect(submit).toBeDisabled()

    await page.getByTestId('vehicle-capture-make').fill('Mercedes')
    await page.getByTestId('vehicle-capture-model').fill('Sprinter')
    await page.getByTestId('vehicle-capture-year').fill('2018')

    await expect(submit).toBeEnabled()
    await submit.click()

    // Wait for navigation to /vehicles/:newId.
    await page.waitForURL(`**/vehicles/${NEW_VEHICLE_ID}`, { timeout: 10_000 })

    // Verify the request body shape.
    expect(postedBody).toMatchObject({
      make: 'Mercedes',
      model: 'Sprinter',
      year: 2018,
      status: 'offered',
      source_reply_id: REPLY_ID,
      source_reply_email: 'gerhatova@gevotransport.eu',
    })

    // Strict console gate.
    expect(consoleNoise, `Console noise observed:\n${consoleNoise.join('\n')}`).toEqual([])
  })
})
