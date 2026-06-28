# Adversarial Fixes — Closing all gaps from tree-map + adversarial testing

**Status:** Superseded
**Datum:** 2026-04-27
**Trigger:** Closed in master plan 2026-04-30; adversarial edge fixes folded into phase 0

**Source inputs:**
- `docs/audits/2026-04-27-tree-map.md` (7 adversarial edges + 6 concurrency hazards)
- This session's adversarial findings:
  - Plus-alias suppression bypass (`test+tag@` not blocked when `test@` suppressed)
  - 3 ClassifyReply evasions (already fixed in commit 29f1303)
  - Schema A/B drift (already fixed in commit cc6072c)

## Issue catalogue

### Sprint A — P0 (compliance / security)

| ID | Issue | Source | Fix |
|---|---|---|---|
| A.1 | Plus-alias suppression bypass — Gmail aliasing means `test+anything@` routes to same inbox as `test@`, but suppression treats them as different. Recipient still receives despite opt-out. | adversarial test 2026-04-27 | Strip `+tag` from local part before suppression lookup OR add canonicalisation column. |
| A.2 | pickMailbox concurrent counter race — `sentCounts` map written without lock during dispatch | tree-map hazard #1 | Verify sync.Mutex coverage; add race test |
| A.3 | SuppressEmail SELECT-before-INSERT race — concurrent suppress can both pass SELECT then both INSERT (one fails on UNIQUE) | tree-map adversarial edge #5 | Use INSERT … ON CONFLICT DO NOTHING |

### Sprint B — P1 (correctness)

| ID | Issue | Fix |
|---|---|---|
| B.1 | `domainDayCount` lazy cache race — multiple goroutines per tick may both miss cache + both query DB | sync.Map or sync.Mutex around cache ops |
| B.2 | `goroutine leak in recalc` — `go func()` spawned per send, not awaited, orphaned on context cancel | accept WaitGroup or context-cancel path |
| B.3 | `mailbox_alerts` race on concurrent bounce write — two bounce events both flip status + write alert without CAS | wrap in `WHERE status != 'bounce_hold'` predicate |

### Sprint C — P2 (observability)

| ID | Issue | Fix |
|---|---|---|
| C.1 | BFF `.catch(err => console.error)` swallow — Sentry breadcrumb missing | Add Sentry capture in BFF catch handlers |
| C.2 | Sentry async capture not flushed on panic exit | telemetry.FatalExitFn already flushes; audit panic recovery sites |
| C.3 | `.env` parsing — split('=') without quote handling | switch to dotenv-parse-variables |

### Sprint D — P3 (testability)

| ID | Issue | Fix |
|---|---|---|
| D.1 | Relay key derivation hardcoded `time.Now()` | inject clock interface |
| D.2 | Template injection — user-controlled TemplateName via DB sequence_config | Allowlist filenames matching `[a-z0-9_]+\.tmpl` |

## Execution priorities

Fix in this order (autonomously, propose-execute-summarize loop):

1. A.1 Plus-alias suppression — high impact, 30 min
2. A.3 SuppressEmail upsert — high impact, 15 min
3. B.1 domainDayCount race — medium impact, 30 min
4. B.2 recalc goroutine leak — medium impact, 30 min
5. B.3 mailbox_alerts CAS — medium impact, 20 min
6. D.2 Template name allowlist — security boundary, 15 min
7. C.1 BFF Sentry capture — observability, 30 min (deferred — BFF not deployed)
8. A.2 pickMailbox race verification — already protected via sync.Mutex per existing tests; just verify

## Hard rules

1. NEsendovat na real B2B bez explicit GO (memory `feedback_campaign_send`).
2. Mailbox passwords v DB, ne env (memory `feedback_mailbox_passwords_via_db`).
3. Žádný direct SMTP z localhost (memory `feedback_no_direct_smtp`).
4. ≥10 test cases per change (memory `feedback_extreme_testing`).

## Deferred

- C.1, C.2, C.3 BFF observability — depends on S9 (BFF deployment decision)
- D.1 Relay clock injection — meaningful refactor; out of scope this session
- Plus-alias normalisation — actually mid effort; scope decides whether
  legitimate `team+sales@firma.cz` aliases break (they would).
