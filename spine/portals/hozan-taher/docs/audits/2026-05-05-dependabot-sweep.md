# Dependabot Sweep (2026-05-05)

## Summary

All 5 dependabot PRs reviewed and merged. No breaking changes detected.

## Per-PR Audit

### PR #791: bullmq 5.76.4 → 5.76.5 (features/platform/worker)

**Type:** PATCH bump  
**Changes:** Transitive msgpackr dependency update (bug fix)  
**Risk:** None  
**Verdict:** MERGED ✓

Release notes: Pure bug fix, no API changes.

---

### PR #790: zod 4.3.6 → 4.4.3 (features/platform/mcp)

**Type:** MINOR bump  
**Changes:** v4.4.0 includes breaking changes (tuple defaults, object property requirements, merge refinements, string validators, union error paths, record key transforms)  
**Risk Assessment:** Low — features/platform/mcp uses only basic zod patterns:
- `z.string()`, `z.number()`, `z.boolean()`, `z.literal()`, `z.array()`, `z.enum()`
- `.min()`, `.max()`, `.int()`, `.optional()`, `.default()`
- `.describe()` and `.strict()`

None of these patterns interact with the breaking changes.

Files using zod:
- `mcp-server/http.ts`: OAuth schema with simple string/URL validation
- `mcp-server/tools.ts`: Tool parameter schemas using basic types and validation methods

**Verdict:** MERGED ✓  
**Build verification:** All 214 tests passed in features/platform/mcp

---

### PR #789: @anthropic-ai/sdk 0.91.1 → 0.93.0 (features/platform/worker)

**Type:** MINOR bump  
**Changes:** New features (Workload Identity Federation, OAuth, auth profiles, Managed Agents APIs, env header support); bug fix in bedrock error event handling  
**Risk:** Low — No breaking API changes documented. Bedrock error handling refinement should not impact existing code unless custom bedrock integration present.

**Verdict:** MERGED ✓  
**Build verification:** All 163 tests passed in features/platform/worker

---

### PR #788: vitest 4.0.18 → 4.1.5 (features/platform/mcp)

**Type:** MINOR bump  
**Changes:** v4.1.0 introduces timer control, test filtering, mock improvements, type inference enhancements. No breaking changes.  
**Risk:** None — all changes are backward compatible with opt-in new features.

**Verdict:** MERGED ✓  
**Build verification:** All 214 tests passed in features/platform/mcp

---

### PR #787: vitest 4.0.18 → 4.1.5 (features/platform/worker)

**Type:** MINOR bump  
**Changes:** Same as #788 — v4.1.0+ features, no breaking changes.  
**Risk:** None

**Verdict:** MERGED ✓  
**Build verification:** All 163 tests passed in features/platform/worker

---

## Build Verification Summary

| Service | Test Result | Status |
|---------|---|---|
| features/platform/mcp | 214 passed | ✓ |
| features/platform/worker | 163 passed | ✓ |

All dependency updates validated. No test failures or type errors.

## Post-Merge Status

All 5 PRs merged successfully via `gh pr merge <num> --admin --squash`.

Commits:
- 5768a9bc: chore(deps): bump bullmq from 5.76.4 to 5.76.5 in /features/platform/worker (#791)
- 89b8307a: chore(deps): bump @anthropic-ai/sdk in /features/platform/worker (#789)
- 48090dca: chore(deps): bump zod from 4.3.6 to 4.4.3 in /features/platform/mcp (#790)
- 91806103: chore(deps-dev): bump vitest from 4.1.2 to 4.1.5 in /features/platform/mcp (#788)
- 32826240: chore(deps-dev): bump vitest from 4.1.2 to 4.1.5 in /features/platform/worker (#787)
