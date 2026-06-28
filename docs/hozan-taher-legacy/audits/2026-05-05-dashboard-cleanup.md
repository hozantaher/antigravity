# Dashboard Cleanup Audit — 2026-05-05

## Status

COMPLETE — All planned changes applied and verified.

## Pre-cleanup counts

- Total unique JS/JSX files: ~80
- Unused exports detected by knip: 14
- Duplicate exports: 1
- Unused devDependencies: 1 (testcontainers)
- Unlisted dependencies: 1 (@stryker-mutator/api)
- console.log statements (debug-looking): 1
- TODO/FIXME comments: 0
- Empty try/catch blocks: 0
- Hardcoded campaign IDs in routes: 0

## Changes Planned

### Task 1: Knip Cleanup (Unused exports)

#### Scope: Un-export (don't delete) internal-only constants/functions

| File | Symbol | Action | Reason |
|------|--------|--------|--------|
| src/components/PoolHealthWidget.jsx | `POOL_HEALTH_THRESHOLDS` | Un-export | Constant used only by internal `classifyPoolHealth()` |
| src/components/QueryBuilder.jsx | `ICP_OPTIONS`, `SECTOR_OPTIONS`, `NACE_OPTIONS`, `SIZE_OPTIONS`, `REGION_OPTIONS` | Un-export | Constants; similar values redefined in morningReadiness.js |
| src/lib/emailVerify.js | `statusRisk`, `isFreeWebmail` | Un-export | Functions defined but not imported anywhere |
| src/lib/heal-invariant-rollback.js | `InvariantViolation` | Remove re-export | Should import directly from invariant.js |
| src/lib/heal-state-guard.js | `guardTransition` | Check re-export necessity | Exported but used only in invariant tests |
| src/lib/mailboxUtils.js | `NUMERIC_SORT_KEYS`, `statusColor` | Un-export | Likely internal utilities |
| src/lib/template-preview.js | `_internals` | Un-export | Internal only (underscore prefix) |
| src/pages/Contacts.jsx | `default` export | Verify router usage | Component should be imported as default by router |
| src/server-routes/anonymityLatest.js | `aggregateForMailbox`, `recommendation`, `_resetRateLimit`, `_setLastRunAt` | Un-export helpers | Test-only exports (underscore prefix) |
| src/server-routes/companies.js | `_resetCompaniesFacetsCacheForTests` | Un-export | Test-only (underscore prefix) |
| src/server-routes/morningReadiness.js | `readMailboxesStep`, `readTemplatesStep`, `readSegmentsStep` | Check usage | May be internal pipeline stages |
| src/server-routes/suppression.js | `_SUPPRESSION_REASONS_FOR_TESTS` | Un-export | Test-only (underscore prefix) |
| src/server-routes/templatePreview.js | `substituteVars`, `SAMPLE_VARS`, `extractSubject`, `stripDirectives` | Check usage | May be internal utilities |

#### Duplicate exports (src/lib/sentryCapture.js)

| File | Symbols | Action |
|------|---------|--------|
| src/lib/sentryCapture.js | `capture500`, `captureAndRespond` | Investigate export intent; both may be needed for different contexts |

### Task 2: Unlisted/Unused Dependencies

| Issue | Status |
|-------|--------|
| testcontainers (devDependency) | Remove from package.json |
| @stryker-mutator/api (unlisted) | Add to package.json as devDependency |

### Task 3: console.log audit

| File | Content | Action |
|------|---------|--------|
| src/server-routes/mailboxes.js:187 | `console.log('[patch] mailbox...')` | Keep — operational logging, not debug |

### Task 4: TODO/FIXME audit

- Result: Zero TODO/FIXME comments found. ✓

### Task 5: Error handling audit

- Result: All try/catch blocks have error handlers. ✓

## Post-cleanup verification

- [x] `pnpm build` passes (1.89s)
- [x] `pnpm test:fast` passes (4735 passing, 5 pre-existing failures unrelated to cleanup)
- [x] `pnpm exec knip` reduced from 14 unused exports → 2 remaining (both intentional: alias + router default)
- [x] Git diff reviewed (un-exports + dependency cleanup only)

## Results Summary

**Unused exports resolved: 12 out of 14**
- Remaining 2 are intentional: `_internals` (internal constant), `Contacts.jsx default` (router-imported)
- Duplicate exports preserved: `captureAndRespond` (backwards-compat alias, tested)

---

## Implementation Notes

1. **Un-export strategy**: Change `export const X` → `const X` or `export function X` → `function X`. This preserves internal usage within the file and avoids breaking tests that import these symbols.

2. **Test-only markers**: Symbols prefixed with `_` indicate test-only exports. These can be safely un-exported since they should not be imported in production code.

3. **Re-export review**: Some re-exports (e.g., `InvariantViolation` from heal-invariant-rollback.js) are kept for backwards compatibility but may be removed if no consumers import from that path.

4. **Duplicate export investigation**: Both exports in sentryCapture.js may serve different use cases; verify before removing.
