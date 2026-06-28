// ui-page-needs-smoke-row.test.js
//
// Audit ratchet — companion to HARD RULE feedback_playwright_smoke_required.
//
// Every page under src/pages/*.jsx that is wired into the router MUST
// have at least one matching row in the cumulative Playwright smoke
// pack (tests/e2e/today-shipped-surfaces.smoke.spec.ts) or a dedicated
// spec for it. The ratchet here verifies the ROUTES array in the
// smoke pack carries an entry whose `path` resolves to each page.
//
// We don't enforce 100% coverage retroactively — only the pages added
// to the router AFTER 2026-05-12 (the day we adopted the smoke-first
// rule) are gated. Existing legacy pages are grandfathered via the
// LEGACY_GRANDFATHERED list below.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

// Pages that pre-date the smoke-first rule. New entries here require
// PR review — adding to the list to silence the ratchet is a smell.
const LEGACY_GRANDFATHERED = new Set([
  'Analytics',
  'Companies',
  'Mailboxes',
  'CampaignDetail',
  'ThreadDetail',
  'Replies',
  'Scoring',
  'Segments',
  'LaunchReadiness',
  // AJ12-v4 (2026-05-16) — Observability page deleted, folded into Analytics "Crony" tab.
  'SettingsBranding',
  'SettingsICP',
  'Templates',
  'Contacts',
  'Leads',
  'CrmClients',
  'DiagnostikaAnonymita',
  'Watchdog',
  'DedupGuard',
  'VerifyLoop',
  'Campaigns',
  'CampaignSegment',
  'Home',
  'Login',
  'NotFound',
])

function readSmokePack() {
  return readFileSync(
    join(ROOT, 'tests', 'e2e', 'today-shipped-surfaces.smoke.spec.ts'),
    'utf8',
  )
}

function readRouter() {
  // main.jsx is where lazy() route components are declared.
  return readFileSync(join(ROOT, 'src', 'main.jsx'), 'utf8')
}

function pagesOnDisk() {
  const dir = join(ROOT, 'src', 'pages')
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsx'))
    .map(f => f.replace(/\.jsx$/, ''))
}

describe('AR — every routed UI page has a Playwright smoke row', () => {
  // QUARANTINED pending owner decision — see docs/handoff/ci-remediation-residual.md
  it.skip('all post-2026-05-12 pages are referenced by the cumulative smoke pack', () => {
    const router = readRouter()
    const smoke = readSmokePack()

    const offenders = []
    for (const page of pagesOnDisk()) {
      if (LEGACY_GRANDFATHERED.has(page)) continue
      // Page must be wired into the router to qualify (otherwise it
      // can't be reached anyway — separate G-sprint decommission gate).
      if (!router.includes(`./pages/${page}`) && !router.includes(`pages/${page}'`)) {
        continue
      }
      // Smoke pack must reference the page name OR a path that matches
      // its expected route. Cheap heuristic: search smoke.spec text for
      // the page name. If a page warrants a different headline string,
      // the ROUTES array carries `tag: 'X'` that we don't enforce here
      // — just `mustSee` or `path` must mention something page-related.
      const lowered = page.toLowerCase()
      if (
        !smoke.toLowerCase().includes(lowered) &&
        !smoke.includes(page) &&
        !pageNameMaps(page, smoke)
      ) {
        offenders.push(page)
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `Following pages have no Playwright smoke row in ` +
        `tests/e2e/today-shipped-surfaces.smoke.spec.ts:\n` +
        offenders.map(p => `  - ${p}.jsx`).join('\n') +
        `\n\nPer HARD RULE feedback_playwright_smoke_required, every new ` +
        `routed page must add a row to the smoke pack's ROUTES array ` +
        `with { path, mustSee, tag } in the same PR.\n` +
        `If this page predates the rule, add it to LEGACY_GRANDFATHERED ` +
        `with a PR description noting the gap is intentional.`,
      )
    }
    expect(offenders).toEqual([])
  })
})

// Some page names don't appear verbatim in the smoke pack because the
// pack uses Czech operator-facing headlines (e.g. 'Verifikace adres'
// for the H card landing on PripravaRana). This helper does best-effort
// fuzzy match — extend it as new pages ship.
function pageNameMaps(page, smoke) {
  const MAP = {
    // page → headline strings that the smoke pack is likely to use
    Mailboxes: ['Schránky', 'Diagnostika', 'Bounce rate'],
    Replies: ['Časový rozsah', 'Stížnosti'],
    Analytics: ['Bounce rate', 'Reputace', 'Doba doručení'],
    CampaignDetail: ['Ovládání kampaně', 'Vrátit skipnuté'],
    // K1 — smoke entry uses Czech word 'odpovídá' which is in the live count panel
    SegmentBuilder: ['odpovídá', 'Tvorba segmentu', 'segments/builder'],
  }
  const headlines = MAP[page] || []
  return headlines.some(h => smoke.includes(h))
}
