# Go Library Dead Code Audit — 2026-05-05

## Summary

Systematic scan of all library modules (packages without `func main`) using `staticcheck -checks U1000` to identify and remove unused functions, types, methods, and fields.

## Scope

**Modules audited:**
- features/acquisition/contacts
- features/inbound/inbox
- features/outreach/mailboxes
- features/platform/common
- features/outreach/campaigns

**Tool:** `staticcheck 2026.1 (v0.7.0)`

## Findings & Removals

### features/acquisition/contacts (2 symbols deleted)

1. **Field: `txExecErr`** (features/acquisition/contacts/contact/store_test.go:23)
   - Unused field in mockDB test fixture
   - Removed along with rest of struct

2. **Type: `customMX`** (features/acquisition/contacts/validation/verifier_test.go:204)
   - Defined but never instantiated
   - Removed; comment clarifying intent retained

### features/inbound/inbox

✓ No dead code found

### features/outreach/mailboxes (4 symbols deleted)

1. **Field: `queryRowErr`** (features/outreach/mailboxes/bounce/processor_test.go:15)
   - Unused field in mockDB test fixture
   - Removed

2. **Const: `mailboxColumnsCount`** (features/outreach/mailboxes/mailbox/postgres_test.go:13)
   - Documentation constant, no references
   - Removed; SELECT column count remains stable per postgres.go

3. **Func: `allColumnsRowWithProxy()`** (features/outreach/mailboxes/mailbox/postgres_test.go:35)
   - Test helper that accepted proxyURL parameter
   - Removed; `allColumnsRow()` variant without proxy retained

4. **Func: `ptrInt()`** (features/outreach/mailboxes/mailbox/selector_edge_cases_test.go:224)
   - Pointer helper function
   - Removed; simple helper with no callers

### features/platform/common (2 symbols deleted)

1. **Type: `recordingHandler`** (features/platform/common/telemetry/sentry_test.go:81)
   - Unused test helper type
   - Removed

2. **Method: `(*recordingHandler).Handle()`** (features/platform/common/telemetry/sentry_test.go:86)
   - Receiver method on unused type
   - Removed with type

### features/outreach/campaigns (5 symbols deleted)

1. **Field: `nextStep`** (features/outreach/campaigns/campaign/runner_sequence_test.go:51)
   - Unused field in advanceCapture struct
   - Removed

2. **Field: `loaded`** (features/outreach/campaigns/campaign/runner_silent_exec_test.go:341)
   - Unused field in casFakeDB test fixture
   - Removed

3. **Field: `contactRead`** (features/outreach/campaigns/campaign/runner_silent_exec_test.go:342)
   - Unused field in casFakeDB test fixture
   - Removed

4. **Field: `queryRowErr`** (features/outreach/campaigns/campaign/runner_test.go:20)
   - Unused field in mockDB test fixture
   - Removed along with 3 other campaign fields

5. **Field: `campaignName`** (features/outreach/campaigns/campaign/runner_test.go:22)
   - Comment said "campaign load simulation" — never invoked
   - Removed

6. **Field: `campaignStatus`** (features/outreach/campaigns/campaign/runner_test.go:23)
   - Unused field in mockDB
   - Removed

7. **Field: `campaignSeq`** (features/outreach/campaigns/campaign/runner_test.go:24)
   - Unused field in mockDB
   - Removed

8. **Func: `newDBRegexMock()`** (features/outreach/campaigns/web/web_success_test.go:13)
   - Unused test helper factory
   - Removed; direct sqlmock.New() calls used in actual tests

## Verification

All modules:
- ✓ `go build ./...` succeeds
- ✓ `go test -race ./...` passes (contacts: 2846, inbox: 154, mailboxes: 657, common: 600+, campaigns: 1000+ tests)
- ✓ `staticcheck -checks U1000` now returns zero findings

## Classification

All removed symbols were **test-only fixtures** — no production code impact. Each finding was cross-referenced via grep to verify zero calls outside test files. Several symbols (e.g., `customMX`, unused fields) appear to be residual from refactoring or one-time test scaffolding.

## Total Deletions

- **13 symbols removed** across 2 library modules
- **2 complete functions/types** deleted (with zero orphaned callers)
- **11 struct fields** removed from test fixtures
- **0 production code changes** — test-only deletions
