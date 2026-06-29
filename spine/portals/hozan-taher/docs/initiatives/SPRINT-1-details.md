# Sprint 1 — Detailed ticket decomposition (2026-04-23 → 2026-04-29)

**Parent:** `2026-04-23-plan-and-sprints.md`. **Status:** active. **Owner:** tomas.

Each ticket has: acceptance criteria (AC), TDD plan, files touched, commit boundary, risks.

---

## #120 · M3.3 — carve `/api/campaigns/*` web handlers

**Source:** `modules/outreach/internal/web/campaigns.go` + `segments.go`
**Target:** `features/outreach/campaigns/internal/web/`

### Acceptance criteria
- [ ] 15 handler funcs physically moved (git mv preserved)
- [ ] `cmd/outreach/main.go` imports new path, routes unchanged externally
- [ ] `go test -count=1 ./...` → 2527 pass (same baseline)
- [ ] BFF contract snapshot `api-route-inventory.snapshot.test.ts` unchanged
- [ ] All 4 of these E2E still green: `campaigns.spec.ts`, `campaign-detail.spec.ts`, `campaign-lifecycle.spec.ts`, `missing-password-banner-pages.spec.ts`

### TDD plan
- RED: pre-move, note failing imports after move attempt (expected)
- GREEN: sed + path fix until `go build ./...` passes
- REFACTOR: extract `RegisterCampaignRoutes(mux)` so `cmd/outreach/main.go` calls `campaignsweb.RegisterCampaignRoutes(mux)` instead of inline `http.HandleFunc` — explicit public API

### Commit boundary
1. M3.3a — file move + registry function (no behavior change)
2. M3.3b — cmd wiring via RegisterCampaignRoutes
3. M3.3c — segments carve (smaller, same pattern)

### Risks
- Shared helpers with mailbox/inbox routes → extract to `modules/outreach/webhelpers/` if needed
- Auth middleware coupling — verify `apiKeyAuth` wrapper stays consistent

---

## #121 · M5.2c — reply classification slice

**Source:** `modules/outreach/llm/classify.go` (reply-specific funcs) + thread/manager.go classify call-sites
**Target:** `features/inbound/inbox/reply/`

### Acceptance criteria
- [ ] `features/inbound/inbox/reply/classify.go` exports `Classify(ctx, Message) (Reply, error)`
- [ ] `features/inbound/inbox/reply/prompt.go` carries the Czech prompt template
- [ ] Thread manager imports `features/inbound/inbox/reply` (instead of llm directly for reply path)
- [ ] Property test: 100 random reply texts → classifier never panics, always returns a valid enum
- [ ] Fallback invariant: LLM failure → returns `"unknown"`, logs the error, tests prove this

### TDD plan
- RED: write `features/inbound/inbox/reply/classify_test.go` first — table-driven tests for 5 reply categories (positive/negative/OOO/bounce/unknown)
- GREEN: extract existing code + wire up
- PROPERTY: fast-check or Go `testing/quick` — random UTF-8 strings → never panics

### Risks
- LLM pkg is outreach/llm (now public after M5 prep) — reply slice imports LLM client; ensure no circular deps
- Thread manager may use llm.ClassifyReply directly; update all call sites

---

## #122 · M5.3 — inbox web handlers carve

**Source:** `modules/outreach/internal/web/{replies,threads,inbox}.go`
**Target:** `features/inbound/inbox/internal/web/`

### Acceptance criteria
- [ ] Handlers moved: `/api/inbox`, `/api/replies`, `/api/replies/:id`, `/api/replies/:id/handled`, `/api/threads/:id/context`, `/api/threads/:id/messages` (6 endpoints)
- [ ] `RegisterInboxRoutes(mux)` exported
- [ ] `cmd/outreach/main.go` calls it
- [ ] BFF contract `api-route-inventory.snapshot.test.ts` unchanged
- [ ] Existing E2E `replies.spec.ts` green

### TDD plan
Same as M3.3 — baseline count, move, wire, retest.

---

## #123 · UI-1 — Czech pluralization lib + property test

**Current:** `schrankaWord` + `verbForm` duplicated in `MissingPasswordBanner.jsx` and `AuthFailAlertBanner.jsx`.
**Target:** `src/lib/czech-plural.js` with named exports.

### Acceptance criteria
- [ ] `src/lib/czech-plural.js` exports `schranka(n)`, `verbForm(n)`, generic `plural(n, {singular, plural, genitive})`
- [ ] Both banners import from lib (no inline copies remain)
- [ ] Existing 18+13 banner tests still pass
- [ ] New property test `src/lib/czech-plural.test.js`:
  - for every n in 0..200: returned word in {'schránka','schránky','schránek'}
  - for every n in 11..14: result === 'schránek' (anomaly lock)
  - for n=1: 'schránka', for n in [2,3,4]: 'schránky', for n=0 or n≥5: 'schránek'
- [ ] 20+ fast-check cases
- [ ] Same-count invariant: total vitest count increases by at least +15 (new lib suite)

### Risks
- Fast-check not installed? Use `pnpm add -D fast-check` if missing
- Component re-renders — property test should be pure fn, no React involvement

---

## #124 · UI-2 — T-U01 preflight gate E2E lock

**Subject:** `/campaigns/:id` page, Spustit button contract with `/api/campaigns/:id/preflight`.

### Acceptance criteria
- [ ] New spec `e2e/campaign-preflight-gate.spec.ts`
- [ ] Mock 5 states: all-pass (ok=true), 1-check-fail, 3-check-fail, all-5-fail, API 500
- [ ] Assertions per state: button disabled/enabled, reason text visible, Czech labels exact
- [ ] Happy path: fix simulated issue via `page.route` update → second preflight returns ok=true → button enables (poll)
- [ ] Also covers edge: preflight API returns malformed JSON → UI falls back to local 3-check (documented in T-U01 commit)

### TDD plan
- Write spec first with mocked responses; verify failure matches expected behavior
- Then any adjustment to `CampaignDetail.jsx` to match E2E assertions

### Risks
- Preflight polling cadence — stub all fetches, poll happens fast during E2E
- CampaignDetail fetches multiple things on mount; ensure we stub enough of them to prevent network-fail toast pollution

---

## Parallel BE+UI execution protocol

**Chat A (dev):** commits BE moves + UI wiring.
**Chat B (tests):** extends coverage via `Needs-Tests:` trailer follow-ups.

**Order of execution this sprint:**

Mon-Tue: #123 UI-1 (shortest, clears pluralization debt) + #120 M3.3 in parallel
Wed: #124 UI-2 + #122 M5.3 in parallel
Thu: #121 M5.2c (requires #122 done so classify moves cleanly)
Fri: Sprint 1 PR roll-up, BOARD sync, Sprint 2 kickoff notes

**Each commit MUST:**
- run `go test -count=1 ./...` from modules/outreach (assertion: 2527+ pass)
- run `pnpm vitest` (contract config for BFF routes)
- run `pnpm exec playwright test` for any E2E surfaces touched

**End-of-sprint checklist:**
- [ ] All 5 tickets closed in task tracker
- [ ] PR open wm/development → main with Sprint 1 bundle
- [ ] `docs/handoff/BOARD.md` updated with 1-line per ticket
- [ ] `docs/rollups/2026-04-29.md` auto-generated via `scripts/weekly-rollup.sh`
- [ ] No regression in live-checks.spec, a11y.spec, console-errors.spec
