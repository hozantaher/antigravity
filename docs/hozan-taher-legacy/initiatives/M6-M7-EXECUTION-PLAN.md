# M6 + M7 Execution Plan — 2026-04-23

**Scope:** Close #88 (M6 dashboard shell cleanup) + #89 (M7 modules/outreach erasure). Both deferred from Sprint 1 — this doc frames the remaining work with concrete acceptance criteria so a future 4-6h block can execute cleanly.

## Current state (end of Sprint 1 / start of Sprint 2)

### Shipped ✅

- **M6.1 scaffold:** All 4 `@hozan/*-ui` packages exist (mailboxes, campaigns, inbox, contacts) with `package.json` + barrel exports.
- **M6.1 workspace wiring:** `pnpm-workspace.yaml` registers all 4. Dashboard `package.json` declares them as `workspace:*` deps.
- **M6.1 smoke test:** `src/lib/hozan-ui-smoke.test.js` verifies all 4 barrel imports resolve.

### Blocked by relative-import chain

The page files under `features/platform/outreach-dashboard/src/pages/*.jsx` use:

```js
import useStore from '../store'
import Field from '../components/Field'
import { useResource } from '../hooks/useResource'
import { T } from '../lib/tokens'
```

Moving a page file physically to `features/outreach/mailboxes/ui/src/Mailboxes.jsx`
breaks every `../` relative import (the source tree beneath `services/` doesn't contain `store`, `components`, `hooks`, `lib`).

## M6.2 execution path (4h block)

### Option A: Tree-shaken barrel (minimal change, recommended)

Keep physical file locations in `features/platform/outreach-dashboard/src/pages/` but flip import semantics so `@hozan/*-ui` is the public surface:

1. **Update main.jsx lazy imports:**
   ```js
   const Mailboxes = lazy(() => import('@hozan/mailboxes-ui/Mailboxes'))
   const Campaigns = lazy(() => import('@hozan/campaigns-ui/Campaigns'))
   // … etc for all pages
   ```

2. **Leave `@hozan/*-ui` barrels as thin re-exports** (current state):
   ```js
   // features/outreach/mailboxes/ui/src/Mailboxes.jsx
   export { default } from '../../../../features/platform/outreach-dashboard/src/pages/Mailboxes.jsx'
   ```

3. **Acceptance:**
   - `pnpm build` green (Vite tree-shakes correctly through the re-export)
   - `pnpm exec playwright test` → all 200+ E2E green
   - `pnpm vitest run` → all unit + contract green
   - `src/lib/hozan-ui-smoke.test.js` passes

**Why this works:** Vite bundles each lazy chunk via the resolved barrel, which still points at the dashboard source file. No physical move, just import-path flip. Zero `../` import breakage.

**Trade-off:** `services/<domain>/ui/` remains a symlink-like barrel — not yet "domain-owned" source.

### Option B: True physical move (deeper refactor, defer to Sprint 3)

For each page file:

1. Create `services/<domain>/ui/src/lib/` mirroring `features/platform/outreach-dashboard/src/lib/` for domain-specific helpers.
2. For shared helpers (`../store`, `../components/Field`, `../hooks/useResource`), create `@hozan/dashboard-core` workspace package that exports them.
3. `git mv features/platform/outreach-dashboard/src/pages/Mailboxes.jsx features/outreach/mailboxes/ui/src/Mailboxes.jsx`
4. Rewrite all `from '../store'` → `from '@hozan/dashboard-core/store'`
5. Repeat for 16 page files.
6. Acceptance: dashboard `src/pages/` is empty OR contains only thin shims.

Estimated effort: 6-8 hours across all 4 UI packages. Recommended for Sprint 3 or later.

## M7 execution path (depends on M6 complete)

### M7.1 — cmd/outreach relocation

Current: `modules/outreach/cmd/outreach/main.go` imports from all public sub-packages.

Target options:
- **A:** `features/inbound/orchestrator/cmd/outreach/main.go` — single binary orchestrator
- **B:** Each domain gets its own cmd binary (features/outreach/campaigns/cmd, features/inbound/inbox/cmd, etc.)

Option A is simpler and matches Railway's single-service deploy model today.

### M7.2 — shared pkg relocation

The now-empty-ish `modules/outreach/` still houses 33 shared packages that every domain imports (humanize, token, calendar, validation, alert, etc.).

Target: extract each into its proper home:
- `humanize`, `calendar`, `alert`, `metrics`, `audit` → `features/platform/common/` or top-level `pkg/`
- `classify`, `exclusion` → `features/acquisition/contacts/` (company classification)
- `imap`, `thread`, `llm` → `features/inbound/inbox/` (reply handling)
- `sender`, `campaign`, `warmup`, `token`, `protections` → `features/outreach/campaigns/` (send)
- `health`, `db`, `config`, `validation`, `mailsim`, `seed`, `ares`, `honeypot` → `features/platform/common/` (shared infra)

### M7.3 — directory removal

After M7.1 + M7.2, `modules/outreach/` contains only:
- `go.mod` (module `outreach` — empty, can be deleted)
- `docs/`, `configs/`, `ADR-*.md` (keep for historical reference or move to root `docs/`)

Acceptance:
- `modules/outreach/` directory removed OR reduced to docs-only
- `go.work` no longer lists `modules/outreach`
- 4004 Go test baseline stable across the move

## Cross-branch signals (A → B)

Signals to file when executing M6/M7:

- `Needs-Tests: services/<domain>/ui integration after physical move`
- `Breaks-Contract: <api|event|schema>` — N/A for M6 (JS re-exports preserve shape); possibly for M7 if cmd binary restructure changes CLI flags

## When to start

**M6.2 Option A:** Any time — 2h block sufficient. **High confidence, low risk.**

**M6.2 Option B:** Sprint 3 or later — requires `@hozan/dashboard-core` pnpm package first.

**M7:** After M6 complete and Sprint 3 week settles. Requires careful move of 33 packages; do one cluster per commit.

## Why this wasn't done in Sprint 1 closeout

The scaffold (M6.1) was straightforward — just barrel exports. The physical-move work (M6.2 Option B) requires creating `@hozan/dashboard-core` first, which is its own 2-3h task. M6.2 Option A is the pragmatic halfway point that can land in a single block but still leaves the `../` relative imports in place (just routed through the barrel).

Sprint 2 priority is SEND pilot live (#99-#103). M6/M7 slot in once SEND is stable.
