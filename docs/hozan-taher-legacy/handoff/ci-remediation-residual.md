# CI Remediation — Residual Owner Decisions (2026-06-27)

Companion to PR **#1620** (`ci/self-hosted-runner`). The GitHub-Actions billing outage
masked a large pre-existing test-rot; re-enabling CI on the Railway self-hosted runner
exposed it. This session fixed **everything mechanically fixable**:

- relay/sender/vault/onion root-naive tests (chmod-0500 is a no-op under the root runner → ENOTDIR injection)
- anti-trace `SMTPUsername` guard: ~19 stale sender tests + fixtures
- dashboard: wired `typecheck`, bumped **vitest 2.1 → 4** (vite-7 crash)
- **contract suite 187 → 10** (handlers gained advisory-lock + audit pre-SELECT + AP3 rate-limiter queries → pg-mock queues realigned)
- **unit/audit 40 → 20**; scoring NaN/recency clamps
- **CI test-scope split** (the `test --run` all-scope mis-ran contract in jsdom → `test:fast` + `TEST_SCOPE=contract`)
- 3 product re-root path bugs (privacy GDPR notice 500 / template-preview / preflight)

What remains on the `outreach-dashboard` job (`test:fast` + `test:contract`) is **NOT
mechanical** — each needs a business / content / product decision only the owner can make.

## Gate status (PR #1620)
- ✅ sender (`outreach-orchestrator`), relay (`privacy-mail-gateway`), Node Services CI — green on the runner
- ✅ dashboard: install · typecheck · build
- 🔴 dashboard: `test:fast` + `test:contract` — the A–F items below

## Residual — owner decisions

### A. Templates + controller footer  (`test:contract`)
- **Tests:** `bff-template-preview`, `bff-brand-label`, `templates-seed`, `migration-008-integration`
- **Assert:** template names `initial` / `followup1` + controller footer **`BALKAN MOTORS INT DOO`** (+ "Goran Nowak" persona sign-off).
- **Reality:** `modules/outreach/configs/templates/` has only `intro_machinery.tmpl` (no BALKAN footer). Templates are likely DB/migration-seeded — migration 008 has the old "Garaaage" footer; 061 has BALKAN but only heavy-01/03.
- **Decision:** which template set + controller footer is authoritative *now*? → reseed/rename, or update the test expectations.

### B. Doc-content ratchets  (`test:fast`)
- **`cad-a5-rebuild-audit`** → `codebase-awareness.md` missing phrases: "When to run", drift-report interpretation, ratchet-override, self-validation.
- **`test-scripts-shape`** → `CLAUDE.md` / Development-Workflow missing "since #70 | TEST_SCOPE=all" and "README#running-tests".
- **Decision:** should the docs carry those phrases (update docs) or are the ratchets stale (update tests)? Don't add phrases just to pass — that defeats the ratchet.

### C. Security-audit  (`test:fast`)
- **`security.audit`** → flags "Possible secret in `src/firebaseInit.js`".
- **Decision:** real leak (rotate + remove) or false-positive (allowlist)? ⚠️ **treat as a leak until confirmed.**

### D. go.work registration  (`test:fast`)
- **`lab-feedback-loop-shape`** → `go.work` missing `use ./features/platform/operator-practice`.
- **Caveat:** that module ALSO has a `go.sum` gap (`go-sqlmock` missing entry) — adding it to `go.work` may break the workspace build until `go mod tidy` is run on operator-practice first.

### E. Param-rename canary  (`test:contract`)
- **`api-route-inventory.snapshot`** → intentionally red until route params `:contact_id` / `:cc_id` → camelCase (the snapshot labels them "KNOWN VIOLATIONS"). → rename the params, or relax the canary.

### F. Misc edge / config drift  (`test:fast`)
- **`d1-k3-domain-concentration`** (4) → threshold spec looks self-contradictory ("20% uniform = no warn" AND "5.1% = warn"; "top domain = 5%" is impossible with 3 domains). Possibly a real bug — needs the intended thresholds.
- **`ui-page-needs-smoke-row`** → 5 Czech pages (KampanCreate/KampanDetail/LoginPage/SegmentBuilder/TopTargets) lack Playwright smoke rows; grandfather list is English. → add smoke rows or grandfather them.
- **`proxy.cache.ttl`** → asserts `HEALTH_REFRESH_MS` + `src/components/mailboxes/helpers.js`, both removed in the src/app reorg. No repoint target → rehome or drop.
- **`mailboxOpRateLimit`** → a stray `})` closes the describe early; fixing it surfaces 8 `OP_RATE_CAPS` config-drift fails (product `imap_poll` cap 4→12, new F3 `diagnose` op). → reconcile the caps.

### Environment-only (pass on the real runner — no action)
`inverted-fault-harness`, `pre-launch-check`, `memory_tier_audit`, `postgres-container` failed only in the local sandbox (absolute dev paths / `~/.claude` / no Docker). They resolve on CI.

## Unblock options
- **(A) Resolve content** — supply the decisions above → the dashboard job goes fully green.
- **(B) Quarantine + follow-up** — `it.skip(...)` the A–F tests with a link to this doc; #1620 merges now, the queue unblocks, content gets fixed later. Passing-test coverage stays.
