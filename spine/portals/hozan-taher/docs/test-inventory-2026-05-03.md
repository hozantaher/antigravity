# Test Coverage Inventory — 2026-05-03

**Status:** Baseline post-S1/S2 merge. All critical packages tested; relay transport-mode failure detected.

## Go Services Test Count

| Service | Tests | Status | Notes |
|---------|-------|--------|-------|
| features/outreach/campaigns | 1,297 | PASS | sender/ highly instrumented (599 tests) |
| features/inbound/orchestrator | 1,648 | PASS | 13 packages; web/, imap/, thread modules |
| features/outreach/relay | 53 | **FAIL:1** | TestLoadConfigDefaults: transportMode default assertion |
| features/platform/common | 763 | PASS | 12 packages; core libs |
| features/acquisition/contacts | ~400 | PASS | contacts/web + 8 packages |
| features/inbound/inbox | ~150 | PASS | inbox/web + 4 packages |
| features/outreach/mailboxes | ~200 | PASS | mailboxes/watchdog + 6 packages |
| features/compliance/privacy-gateway | ~300 | PASS | privacy-gateway/internal/submission + 5 packages |

**Go Total:** ~5,700+ tests across 8 services. **Blocker:** relay FAIL:1 test.

## Frontend Test Count

| App | Tests | Status | Notes |
|-----|-------|--------|-------|
| features/platform/outreach-dashboard | 206 | WARN | jsdom navigation warnings; all tests pass |

## Critical Finding

**FAIL: relay/cmd/relay/main_test.go:210** — `TestLoadConfigDefaults` asserts `transportMode` default = "direct" but actual = "proxy". **Root cause:** egress canonical (T1, egress_canonical.md) or wireproxy mode update in config init not synchronized with test assertion. Blocks relay service test suite.

## Comparison to 2026-04-25 Baseline

- **Campaigns:** consistent ~1,300 tests (high sender/ coverage maintained)
- **Orchestrator:** +80 tests (imap/ integration growth, thread/ expansion)
- **Relay:** regression flagged (1 failure = new)
- **Dashboard:** 206 tests steady (E2E suite under vite 6)

## Untested Packages

All primary services comprehensive; zero zero-coverage packages in campaigns/, orchestrator/.

## Next Steps

1. Fix relay default transport-mode assertion or update egress canonical (check [egress_canonical.md](../docs/subsystem-maps/egress_canonical.md) commit).
2. Enable coverage reporting in CI pipeline.
