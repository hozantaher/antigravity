# Blind Spot Audit — 2026-04-30

After today's massive merge throughput (40+ PRs incl. #333 sprint-stack-rescue,
#330 mail-lab consolidation, #335 KT-A2 templates, #337 CI scope reduction).
Read-only audit, no code changes.

## A. Test flakes (after PR #333)

Run: `pnpm test --run --bail=5` from `features/platform/outreach-dashboard`.

**Result: 920 pass / 4 fail / 991 total tests across 286 files.**

All four failures share the **same root cause** — global `createRateLimitMiddleware`
returning `429` instead of letting the handler run. The test setup file
`tests/contract/setup.ts` sets `BFF_RATE_LIMIT_DISABLED=1` globally, but the
flag's check at `src/lib/rateLimitMiddleware.js:7` is per-request runtime. The
flag IS being honored at request time, but both failing test files
(`bff-mailboxes.contract.test.ts`, `bff-mailboxes-extended.contract.test.ts`)
hit > 100 requests against the same Express instance and trigger the limiter
at the END of the suite. Either:

- another test file is mutating `process.env.BFF_RATE_LIMIT_DISABLED` (likely
  candidate: `bff-monkey.contract.test.ts` which exercises the limiter
  directly with 100 concurrent requests), OR
- the flag is being clobbered between files due to vitest workers / ordering.

| # | Test name | File | Error | Severity | Cause |
|---|---|---|---|---|---|
| 1 | `GET /api/mailboxes/:id/full-check > returns cached row when fresh` | `bff-mailboxes-extended.contract.test.ts:806` | `expected 429 to be 200` | HIGH | rate-limiter fires; flag missing/clobbered |
| 2 | `GET /api/mailboxes/:id/full-check > force=1 bypasses cache and 404s when mailbox missing` | `bff-mailboxes-extended.contract.test.ts:812` | `expected 429 to be 404` | HIGH | same |
| 3 | `GET /api/mailboxes/:id/full-check > 500 on cache lookup pg throw` | `bff-mailboxes-extended.contract.test.ts:817` | `expected 429 to be 500` | HIGH | same |
| 4 | `POST /api/mailboxes/:id/auth-reset > 400 on negative id` | `bff-mailboxes.contract.test.ts:668` | `expected 429 to be 400` | HIGH | same |

**Severity:** HIGH (blocks dev workflow — `pnpm test` non-zero exit). NOT
CRITICAL because:
- Production behavior is correct; the limiter is a real defense-in-depth.
- No user-facing regression, only test infra.

**Likely fix path:** in `bff-monkey.contract.test.ts`, store + restore
`BFF_RATE_LIMIT_DISABLED` in `beforeEach` / `afterEach`, OR run rate-limit
monkey tests in a separate `vitest` project so they don't share `process.env`.

## B. Bundle size

Run: `pnpm build` from `features/platform/outreach-dashboard`.

**Result: PASS — comfortably within budget.**

| Metric | Value (gzipped) | Budget | Status |
|---|---|---|---|
| Total JS | ~370 KB gzip (sum of all chunks) | 300 KB / app page | WARN (over total but route-split) |
| Per-route initial JS | ~74 KB gzip (vendor-react + index + smallest page) | 300 KB | PASS |
| CSS | 14.75 KB gzip (87 KB raw) | 50 KB | PASS |
| Largest single chunk | `vendor-sentry` 155.16 KB gzip | warn-only chunk | WARN (oversized vendor) |

Top 5 chunks (gzipped):

| Chunk | Size |
|---|---|
| `vendor-sentry-DEIRWVxj.js` | 155.16 KB |
| `vendor-react-DXoTT26f.js` | 60.51 KB |
| `Mailboxes-J5PEEFyp.js` | 25.93 KB |
| `Companies-pdID0qNy.js` | 25.34 KB |
| `vendor-router-o0NftXxG.js` | 13.80 KB |

**Findings:**
- vendor-sentry already split out (good — PR #160 P-2 visible). It's still
  large by raw size but it's a separate vendor chunk so it's cached
  cross-route and cross-deploy.
- Per-route chunks are healthy (< 30 KB gzip each). React Router code-split
  pages working as designed.
- Build emits a Vite chunk-size warning (default 300 KB raw threshold) — this
  is the raw size, not gzipped. Gzipped vendor-sentry is 155 KB which is
  acceptable for an app-page bundle.

## C. A11y audit

**Tooling status: INSTALLED but not running.**

`features/platform/outreach-dashboard/package.json` has:
- `@axe-core/playwright: ^4.11.2`
- `axe-core: ^4.11.3`

I did not find a dedicated `tests/a11y/` directory, nor an axe-core integration
in any `tests/e2e/*.spec.ts`. The dependency exists but is not wired into a
test suite that runs in CI.

**Issues found:** none auditable without running. Couldn't run Playwright
within the 2-minute budget without server boot.

**Recommendation:**
1. Add `tests/e2e/a11y.spec.ts` that runs `AxeBuilder` against the 5 highest-
   traffic pages: `/dashboard`, `/campaigns`, `/contacts`, `/inbox`, `/mailboxes`.
2. Gate at "no serious or critical violations" initially (don't block on
   minor color-contrast warnings until baseline is known).
3. Add a `pnpm test:a11y` script to package.json.

Estimated effort: 1–2 hours (deps already installed).

## D. CLAUDE.md drift

Scanned 14 CLAUDE.md files (`./CLAUDE.md`, `apps/*/`, `services/*/`, `modules/*/`)
for backtick-quoted code-path references with file extensions.

**True drift count: 4 files**, all in service-local CLAUDE.md docs. Other
"missing" matches were either user-memory pointers (`feedback_*.md`,
`project_*.md` — these intentionally reference `~/.claude/.../memory/`,
not repo files) or basenames that DO exist somewhere in the repo (the
shallow check resolved relative paths against the wrong base).

| File | Stale reference | Actual location / status |
|---|---|---|
| `features/acquisition/contacts/CLAUDE.md:24` | `company/email_verify.go` | not found anywhere — likely renamed/deleted |
| `features/inbound/orchestrator/CLAUDE.md:16` | `web/handler_dsr.go` | not found anywhere; DSR handlers live in `features/platform/outreach-dashboard/server.js` (Express BFF, not Go) |
| `features/outreach/mailboxes/CLAUDE.md` | `mailbox/auth_cache.go` | not found anywhere |
| `features/outreach/mailboxes/CLAUDE.md` | `mailbox/registry.go` | not found anywhere |

**Severity: LOW** — service docs only, not user-facing. But the orchestrator
DSR pointer is misleading: it points readers to a Go file that doesn't exist;
the actual DSR endpoints are in the Express BFF.

## E. Operator-practice fixtures

**Status: empty corpus, no faked data.**

- `tests/fixtures/operator-replies/` — directory does not yet exist on disk
  (not git-tracked). The README content quoted in the initiative is
  prospective.
- `scripts/operator-practice/anonymize.mjs` exists and is exercised by
  `features/platform/outreach-dashboard/tests/audit/operator-practice-anonymizer.test.js`
  with synthetic-shaped strings ("Honza Novák", "+420 123 456 789") used
  ONLY to verify the anonymizer's regex. The test header explicitly notes
  this is testing the tool, not training the operator.
- No real `.eml` corpus exists yet in any of the six classification dirs
  (interested / not-interested / ooo / wrong-person / spam / ambiguous).
- No Faker/faker imports anywhere in the operator-practice surface.

**Audit gates (OP1.x) status:**
- `operator-practice-anonymizer.test.js` — present, validates regex.
- `operator-practice-seed-shape.test.js` — present, validates seed-replies CLI shape.
- `operator-practice-replay.test.js` — present.
- `operator-practice-smoke-shape.test.js` — present.
- `operator-practice-playbook-shape.test.js` — present.

These tests act as **shape gates** (they verify the tools exist and
take the right inputs), but there is no gate that **forbids unsanitized
or fabricated content from appearing in the `interested/`, `spam/`, etc.
fixture directories**. Once real anonymized fixtures land, a content-shape
audit (e.g. all `.eml` `From:` headers must match `@anon.lab` domain) would
prevent regression to fake samples.

**Severity: LOW** for now (corpus is empty). MEDIUM once real fixtures land
without a content-shape gate.

## Recommendations ranked by impact

1. **[HIGH — fix today]** Resolve the 4 contract-test 429 failures.
   Most likely fix: in `bff-monkey.contract.test.ts` `afterAll`, restore
   `process.env.BFF_RATE_LIMIT_DISABLED = '1'` (or move the monkey tests
   into their own vitest project so env mutations don't leak). Currently
   `pnpm test` exits non-zero, which blocks the standard pre-commit gate.

2. **[MEDIUM — within sprint]** Wire the already-installed
   `@axe-core/playwright` into a `tests/e2e/a11y.spec.ts` and add a
   `pnpm test:a11y` script. Deps are paid for; the missing piece is
   one ~50-line test file.

3. **[LOW — paid by next operator-practice work]** Add a content-shape
   audit gate that fires when fixture files land in `interested/`,
   `not-interested/`, etc. — assert all `From:` headers match `@anon.lab`,
   no `+420\d{9}`, no `@example\.com`. Prevents Faker regression once the
   corpus starts filling.

4. **[LOW — passing chore]** Fix four stale CLAUDE.md path references in
   `features/acquisition/contacts/`, `features/inbound/orchestrator/`, `features/outreach/mailboxes/`.
   Either delete the lines or update pointers to the actual current
   files. The orchestrator DSR reference is the most misleading because
   it points to a non-existent Go file when the DSR surface is the
   Express BFF.

5. **[INFO — already healthy]** Bundle size is well within budget.
   `vendor-sentry` is the largest single chunk at 155 KB gzip but is a
   shared vendor split with good cross-route cache reuse. No action.
