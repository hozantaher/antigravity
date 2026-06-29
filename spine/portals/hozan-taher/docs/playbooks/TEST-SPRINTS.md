# Test Sprints — Hozan Taher

Plán 5 sprintů pro vybudování sofistikované test suite napříč monorepem. Každý sprint = paralelně dispatchovatelné task files (max 3 soubory per task).

## Přehled

| Sprint | Fáze | Cíl | Tasks | Tier | Paralelně? |
|---|---|---|---|---|---|
| **S1** | Foundation | Unit testy pro netestované Node TS services | 3 | sonnet | ✅ |
| **S2** | Integration | Integration gates pro kritické Go flows | 3 | codex | ✅ |
| **S3** | E2E | Playwright flows pro auth + campaign | 2 | sonnet | ✅ |
| **S4** | Contract & Property | Cross-service kontrakty + property tests | 2 | opus | ✅ |
| **S5** | Observability | Unified coverage + flaky detector | 2 | haiku | ✅ |

**Celkem:** 12 task files, ~8-10 dní při paralelním dispatchu.

## Sprint 1 — Foundation (netestované služby)

Mezera: `features/platform/mcp`, `features/platform/worker`, `features/acquisition/scrapers` = **0 testů**.

- [task-001-mcp-unit-suite](sprint-1-task-001-mcp-unit-suite.md)
- [task-002-worker-unit-suite](sprint-1-task-002-worker-unit-suite.md)
- [task-003-scrapers-unit-suite](sprint-1-task-003-scrapers-unit-suite.md)

Dispatch: `bash tasks/dispatch-batch.sh tasks/tests/sprint-1-*.md`

## Sprint 2 — Integration (kritické Go flows)

Mezera: intelligence loop, SMTP warmup, migration backup/restore — bez integration gates.

- [task-010-intelligence-loop-integration](sprint-2-task-010-intelligence-loop-integration.md)
- [task-011-smtp-warmup-sandbox](sprint-2-task-011-smtp-warmup-sandbox.md)
- [task-012-migration-backup-restore-ci](sprint-2-task-012-migration-backup-restore-ci.md)

Blokuje: S3 (potřebuje běžící integration harness).

## Sprint 3 — E2E (user flows)

Mezera: 2FA enrollment, campaign end-to-end.

- [task-020-auth-2fa-e2e](sprint-3-task-020-auth-2fa-e2e.md)
- [task-021-campaign-send-e2e](sprint-3-task-021-campaign-send-e2e.md)

## Sprint 4 — Contract & Property

Mezera: MCP ↔ outreach API stability, property testing na idempotentní operace.

- [task-030-contract-mcp-outreach](sprint-4-task-030-contract-mcp-outreach.md)
- [task-031-property-outreach-core](sprint-4-task-031-property-outreach-core.md)

## Sprint 5 — Observability

Mezera: coverage se hlásí per-service, ne sjednoceně; flaky detekce chybí.

- [task-040-coverage-unified](sprint-5-task-040-coverage-unified.md)
- [task-041-flaky-detector](sprint-5-task-041-flaky-detector.md)

## Workflow per sprint

1. **Plan:** přečti SPRINTS.md + příslušné task files
2. **Branch:** `task/tests-sprint-N` (nebo per-task branches)
3. **Dispatch:** `bash tasks/dispatch-batch.sh tasks/tests/sprint-N-*.md`
4. **TDD:** RED → GREEN → refactor v každém tasku
5. **Review:** A+B (standard) nebo A+B+C (auth/security tasks)
6. **Merge:** PR do `messingtomas/ht-tests`, pak do `main`

## Governance

- ECC skills: `tdd-workflow`, `golang-testing`, `e2e-testing`, `python-testing` (dle jazyka)
- Coverage gate: nesnižuj existující prahy (privacy 70%, anti-trace 60%, outreach 45%, dashboard 80%)
- Race detection pro všechny Go testy
- Žádné mocky DB v integration testech (viz CLAUDE.md feedback pattern)
