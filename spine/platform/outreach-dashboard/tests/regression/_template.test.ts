// R2 — Regression test template.
// Copy this file when manually creating a regression test for a known
// production incident. Auto-generated tests use scripts/sentry-to-regression-test.mjs.
//
// Naming: tests/regression/INC-YYYY-MM-DD-<short-slug>.test.ts
//
// Conventions:
//   - One incident = one file
//   - it.todo for unfilled reproducer (test scope)
//   - it for filled-in reproducer (gating CI)
//   - Header comment includes Sentry event ID + reproduction steps

import { describe, it, expect } from 'vitest'

describe('Regression INC-YYYY-MM-DD-<slug>', () => {
  // Sentry event: <EVENT_ID>
  // Reported by: <user / monitor>
  // Date: <ISO date>
  //
  // Original error:
  //   <error message + stack top 3>
  //
  // Reproduction steps:
  //   1. <step>
  //   2. <step>
  //   3. <expected vs actual>
  //
  // Root cause:
  //   <analysis>
  //
  // Fix:
  //   <commit SHA or PR URL>
  //
  // Test ensures regression is caught: this test must FAIL on broken main,
  // PASS after fix.

  it.todo('reproduces: <one-line summary of the bug>')

  // Example reproducer template:
  //
  // it('reproduces: malformed body crashes POST /api/templates', async () => {
  //   // Arrange — minimal state matching incident
  //   const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
  //
  //   // Act — exact trigger from incident
  //   const r = await fetch('/api/templates', {
  //     method: 'POST',
  //     headers: { 'content-type': 'application/json' },
  //     body: '',  // missing body — was the trigger
  //   })
  //
  //   // Assert — current main MUST handle gracefully (no 500)
  //   expect(r.status).toBe(400)
  //   expect((await r.json()).error).toMatch(/name required/)
  // })
})
