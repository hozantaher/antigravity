// AJ session (2026-05-15) ratchet — pages deleted in AJ1+AJ2+AJ9 must NOT come back.
// Memory: docs/initiatives/2026-05-15-ux-simplification.md (Pages removal phase).
// Past: AJ1 deleted Scoring (operator never tuned weights), AJ2 deleted Leads
// (table empty), AJ9 deleted PreflightGateModal dead body (modal never rendered).
//
// This ratchet ensures no agent re-adds them by accident during future refactors.

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const PAGES_ROOT = resolve(__dirname, '../../src/pages')
const COMPONENTS_ROOT = resolve(__dirname, '../../src/components')

const REMOVED_PAGES = [
  { path: `${PAGES_ROOT}/Scoring.jsx`, sprint: 'AJ1', reason: 'operator never tuned scoring weights (audit 30d: 0 calls)' },
  { path: `${PAGES_ROOT}/Leads.jsx`, sprint: 'AJ2', reason: 'leads table empty — sales funnel scaffolded but never populated' },
  { path: `${PAGES_ROOT}/SettingsBranding.jsx`, sprint: 'AJ3', reason: 'merged into Settings.jsx with tabs' },
  { path: `${PAGES_ROOT}/SettingsICP.jsx`, sprint: 'AJ3', reason: 'merged into Settings.jsx with tabs' },
  { path: `${PAGES_ROOT}/SettingsThresholds.jsx`, sprint: 'AJ3', reason: 'merged into Settings.jsx with tabs' },
]

const REMOVED_COMPONENTS = [
  { path: `${COMPONENTS_ROOT}/PreflightGateModal.jsx`, sprint: 'AJ9', reason: 'dead modal body — CampaignDetail imported only classifyChecks helper, now in lib/preflightChecks.js' },
  { path: `${COMPONENTS_ROOT}/drawer/DrawerPanel.jsx`, sprint: 'AJ-mini', reason: 'consolidated into Drawer.jsx compound exports' },
  { path: `${COMPONENTS_ROOT}/drawer/DrawerSection.jsx`, sprint: 'AJ-mini', reason: 'consolidated into Drawer.jsx' },
  { path: `${COMPONENTS_ROOT}/drawer/DrawerList.jsx`, sprint: 'AJ-mini', reason: 'consolidated into Drawer.jsx' },
  { path: `${COMPONENTS_ROOT}/drawer/DrawerMetric.jsx`, sprint: 'AJ-mini', reason: 'consolidated into Drawer.jsx' },
]

describe('AJ ratchet: deleted pages must not return', () => {
  for (const { path, sprint, reason } of REMOVED_PAGES) {
    it(`${path.split('/').slice(-2).join('/')} (deleted in ${sprint}) must not exist`, () => {
      const exists = existsSync(path)
      expect(exists, `Restored ${path.split('/').slice(-2).join('/')}. ${reason}. ` +
        `If this page must come back, propose new initiative + remove this ratchet entry.`).toBe(false)
    })
  }
})

describe('AJ ratchet: deleted components must not return', () => {
  for (const { path, sprint, reason } of REMOVED_COMPONENTS) {
    it(`${path.split('/').slice(-3).join('/')} (deleted in ${sprint}) must not exist`, () => {
      const exists = existsSync(path)
      expect(exists, `Restored ${path.split('/').slice(-3).join('/')}. ${reason}. ` +
        `If this component must come back, propose new initiative + remove this ratchet entry.`).toBe(false)
    })
  }
})
