// ═══════════════════════════════════════════════════════════════════════════
//  AS-F3 — /replies/:id ThreadDetail polish pass smoke
//
// Verifies the five operator-approved polish moves landed on /replies/:id:
//   1. The standalone "Přijato: <full datetime>" inline line is GONE.
//   2. Classification badge is the larger 14px / 500 weight prominent pill.
//   3. ThreadContextBar ALWAYS renders (with "—" placeholders for missing
//      company/IČO/campaign data).
//   4. The classify action row renders exactly 4 buttons (no Vyřízeno).
//   5. Sidebar default-open follows viewport-width threshold
//      (SIDEBAR_DEFAULT_OPEN_VIEWPORT_PX = 1280px). Wide viewport →
//      sidebar expanded by default; narrow → collapsed.
//
// Strict console-error gate per HARD rule `feedback_smoke_gate_operator_strict`.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, assertClean } from './_fixtures/console-guard'
import type { Page } from '@playwright/test'

const REPLY_ID = 4242

// AS-F3 default thresholds — also in src/hooks/useToggleState.js. Kept in
// sync as a named constant per HARD rule feedback_no_magic_thresholds T0.
const SIDEBAR_DEFAULT_OPEN_VIEWPORT_PX = 1280
const NARROW_VIEWPORT_PX = 1024 // < 1280 → sidebar should default collapsed
const WIDE_VIEWPORT_PX = 1440   // >= 1280 → sidebar should default open

const REPLY_WITH_COMPANY = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Petr Beneš',
    from_email: 'petr@brnenska-strojirna.cz',
    subject: 'Re: nabídka',
    campaign_id: 7,
    campaign_name: 'Strojírny Q2',
    classification: 'positive',
    handled: false,
    received_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  },
}

const REPLY_NO_CONTEXT = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Jana Bez Kontextu',
    from_email: 'jana@neznamy.cz',
    subject: 'Re: ?',
    campaign_id: null,
    campaign_name: null,
    classification: 'unknown',
    handled: false,
    received_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  },
}

const CONTEXT_WITH_COMPANY = {
  company: { name: 'Brněnská strojírna s.r.o.', ico: '12345678' },
  campaign: { id: 7, name: 'Strojírny Q2', status: 'running', sent: 50, replied: 3 },
}

const CONTEXT_EMPTY = {
  company: null,
  campaign: null,
}

async function stubThread(page: Page, opts: { reply: unknown; context: unknown }) {
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.reply),
    })
  })
  await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"messages":[]}' }),
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.context) }),
  )
  await page.route(`**/api/replies/${REPLY_ID}/attachments`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"attachments":[]}' }),
  )
}

test.describe('/replies/:id — AS-F3 polish pass', () => {
  test('1. drops the "Přijato:" inline datetime line under the header', async ({ page, errs }) => {
    await page.setViewportSize({ width: WIDE_VIEWPORT_PX, height: 900 })
    await stubThread(page, { reply: REPLY_WITH_COMPANY, context: CONTEXT_WITH_COMPANY })
    await page.goto(`/replies/${REPLY_ID}`)

    await expect(page.getByRole('heading', { name: 'Petr Beneš', level: 2 })).toBeVisible({ timeout: 10_000 })

    // The redundant "Přijato: <full datetime>" line under the header
    // (e.g. "Přijato: 18. 5. 2026 14:36:07") must NOT render. The first
    // bubble timestamp + RhythmDivider already convey received-at.
    await expect(page.locator('text=/^Přijato: /')).toHaveCount(0)

    assertClean(errs)
  })

  test('2. classification badge is the prominent 14px / 500 weight pill', async ({ page, errs }) => {
    await page.setViewportSize({ width: WIDE_VIEWPORT_PX, height: 900 })
    await stubThread(page, { reply: REPLY_WITH_COMPANY, context: CONTEXT_WITH_COMPANY })
    await page.goto(`/replies/${REPLY_ID}`)

    const badge = page.getByTestId('anchor-classification-badge')
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await expect(badge).toHaveText('Zájem')

    // 14px / 500 weight per AS-F3 brief. JSdom doesn't resolve CSS vars
    // but Playwright runs against real browsers, so getComputedStyle
    // returns the painted values.
    const styles = await badge.evaluate((el) => ({
      fontSize: getComputedStyle(el).fontSize,
      fontWeight: getComputedStyle(el).fontWeight,
      borderRadius: getComputedStyle(el).borderRadius,
    }))
    expect(styles.fontSize).toBe('14px')
    expect(styles.fontWeight).toBe('500')
    expect(styles.borderRadius).toBe('6px')

    assertClean(errs)
  })

  test('3. ThreadContextBar always renders — with "—" placeholders when company/campaign are missing', async ({ page, errs }) => {
    await page.setViewportSize({ width: WIDE_VIEWPORT_PX, height: 900 })
    await stubThread(page, { reply: REPLY_NO_CONTEXT, context: CONTEXT_EMPTY })
    await page.goto(`/replies/${REPLY_ID}`)

    await expect(page.getByRole('heading', { name: 'Jana Bez Kontextu', level: 2 })).toBeVisible({ timeout: 10_000 })

    const bar = page.getByTestId('thread-context-bar')
    await expect(bar).toBeVisible()
    // Both rails render with "—" placeholder text.
    await expect(page.getByTestId('thread-company-placeholder')).toHaveText('—')
    await expect(page.getByTestId('thread-campaign-placeholder')).toHaveText('—')

    assertClean(errs)
  })

  test('4. classify-actions row renders exactly 4 buttons (Vyřízeno removed)', async ({ page, errs }) => {
    await page.setViewportSize({ width: WIDE_VIEWPORT_PX, height: 900 })
    await stubThread(page, { reply: REPLY_WITH_COMPANY, context: CONTEXT_WITH_COMPANY })
    await page.goto(`/replies/${REPLY_ID}`)
    await expect(page.getByRole('heading', { name: 'Petr Beneš', level: 2 })).toBeVisible({ timeout: 10_000 })

    const classify = page.getByTestId('classify-actions')
    await expect(classify).toBeVisible()
    const buttons = classify.getByRole('button')
    await expect(buttons).toHaveCount(4)
    for (const label of ['Zájem', 'Není zájem', 'Otázka', 'Unsubscribe']) {
      await expect(classify.getByRole('button', { name: new RegExp(`^${label}$`) })).toBeVisible()
    }
    // Vyřízeno is gone.
    await expect(classify.getByRole('button', { name: /^Vyřízeno$/ })).toHaveCount(0)

    assertClean(errs)
  })

  test('5a. sidebar defaults OPEN on wide viewport (>= SIDEBAR_DEFAULT_OPEN_VIEWPORT_PX)', async ({ page, errs }) => {
    // Operator's Mac is wide. Sidebar opens by default — one less click
    // on the hot path. Persisted toggle would override but we clear it.
    await page.setViewportSize({ width: WIDE_VIEWPORT_PX, height: 900 })
    expect(WIDE_VIEWPORT_PX).toBeGreaterThanOrEqual(SIDEBAR_DEFAULT_OPEN_VIEWPORT_PX)
    await stubThread(page, { reply: REPLY_WITH_COMPANY, context: CONTEXT_WITH_COMPANY })
    await page.addInitScript(() => { try { localStorage.removeItem('td.showSidebar') } catch { /* noop */ } })
    await page.goto(`/replies/${REPLY_ID}`)
    await expect(page.getByRole('heading', { name: 'Petr Beneš', level: 2 })).toBeVisible({ timeout: 10_000 })

    await expect(page.getByTestId('context-sidebar')).toBeVisible()

    assertClean(errs)
  })

  test('5b. sidebar defaults COLLAPSED on narrow viewport (< SIDEBAR_DEFAULT_OPEN_VIEWPORT_PX)', async ({ page, errs }) => {
    await page.setViewportSize({ width: NARROW_VIEWPORT_PX, height: 900 })
    expect(NARROW_VIEWPORT_PX).toBeLessThan(SIDEBAR_DEFAULT_OPEN_VIEWPORT_PX)
    await stubThread(page, { reply: REPLY_WITH_COMPANY, context: CONTEXT_WITH_COMPANY })
    await page.addInitScript(() => { try { localStorage.removeItem('td.showSidebar') } catch { /* noop */ } })
    await page.goto(`/replies/${REPLY_ID}`)
    await expect(page.getByRole('heading', { name: 'Petr Beneš', level: 2 })).toBeVisible({ timeout: 10_000 })

    // Only the toggle button renders; the sidebar body is hidden.
    await expect(page.getByTestId('thread-sidebar-toggle')).toBeVisible()
    await expect(page.getByTestId('context-sidebar')).toHaveCount(0)

    assertClean(errs)
  })
})
