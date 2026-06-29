# Sprint 2 — kickoff notes (2026-04-30 → 2026-05-06)

**Parent:** `2026-04-23-plan-and-sprints.md`
**Status:** Prerequisites met, ready to start on 2026-04-30
**Sprint 1 wrap:** `SPRINT-1-FINAL.md`

---

## Sprint 2 goal (original)

"services own `go.mod`" — make `features/outreach/campaigns/` + `features/inbound/inbox/`
runnable modules with their own dep graphs.

## Status on entry (2026-04-23 end of Sprint 1 arc)

Both go.mods already exist:
- `features/outreach/campaigns/go.mod` — module campaigns, has DATA-DOG/go-sqlmock dep
- `features/inbound/inbox/go.mod` — module inbox, has DATA-DOG/go-sqlmock dep

Both modules registered in `go.work`. `go work sync` clean. Sprint 2 goal
effectively reached ahead of schedule during Sprint 1b.

## Revised Sprint 2 tickets

Goal pivots to: **SEND pilot live + relay reorg (M2.3-5)**.

### BE

| # | Ticket | Priority | Effort | Blocker |
|---|--------|----------|-------:|---------|
| #99  | SEND-S1 real Seznam creds (user-side)  | P0 | manual | user |
| #101 | SEND-S3 E2E self-send script           | P0 | 30min  | #99 |
| #103 | SEND-S5 first pilot campaign run       | P0 | 2h     | #99+#101 |
| #84  | M2.3 relay transport/ consolidation    | P1 | 3h     | none (plan ready) |
| #84  | M2.4 relay intake/+delivery/ consolidation | P1 | 2h | #84 M2.3 |
| #84  | M2.5 relay web/ carve                  | P1 | 2h     | #84 M2.4 |

### UI

| # | Ticket | Priority | Effort |
|---|--------|----------|-------:|
| (new) | CampaignNew wizard E2E (debug modal selector) | P2 | 1h |
| (new) | /scoring weight-slider property tests  | P2 | 45min |
| (new) | Visual regression snapshot refresh after carves | P2 | 30min |
| #88  | M6 dashboard shell cleanup (per-domain @hozan/*-ui pkg) | P1 | 4h |

### Cross-cutting

| # | Ticket | Priority | Effort | Notes |
|---|--------|----------|-------:|-------|
| #66 | P0-2 CI zelený na main            | P0 | user-side | billing |
| #69 | P0-5 rotate 3 leaked secrets      | P0 | 30min | before pilot |
| #65 | P0-1 PR #8 resolve + merge        | P0 | 1h | after #66 |
| #73 | P1-4 secret hygiene sweep         | P1 | 2h    |
| #90 | P2-1 merge gate (CI + no-conflict) | P2 | 1h   |

---

## Execution sequence (recommended)

**Day 1 (Mon 2026-04-30):**
- Morning: #69 secret rotation + #66 CI billing unlock
- Afternoon: #99 user delivers Seznam creds → #101 self-send

**Day 2 (Tue 2026-05-01):**
- #103 first pilot campaign (10 contacts, canary mode)
- Monitor via /mailboxes + /watchdog + auth-fail-alert banner

**Day 3 (Wed):**
- M2.3 relay transport/ consolidation
- UI: CampaignNew debug

**Day 4 (Thu):**
- M2.4 + M2.5 relay intake/delivery/web

**Day 5 (Fri):**
- #88 M6 dashboard shell cleanup kickoff
- PR wm/development → main for Sprint 2 bundle
- Weekly rollup

---

## Definition of Done (Sprint 2)

- [ ] At least 5 real emails delivered via pilot (`send_events.status='sent'`)
- [ ] No auth-fail-alert fires during pilot window
- [ ] Relay M2 reorg: 805 tests stable after every consolidation commit
- [ ] M6 kickoff: first per-domain @hozan/*-ui pnpm package scaffolded
- [ ] BOARD 2026-05-06 sync + weekly-rollup generated

---

## Risks + mitigations

| Risk | Mitigation |
|------|-----------|
| Seznam creds delivery slips | User-side blocker; no workaround. Defer #103 to Sprint 3 if still blocked Fri. |
| Relay consolidation breaks tests | Pattern proven 18× in Sprint 1. If any pkg move loses tests, revert to pre-commit state. |
| CI billing not restored | P0-2 is manual; can ship Sprint 2 without CI if local `go test ./...` + `pnpm build` green. |
| Pilot campaign bounces high | Warmup config audit done (#102); canary 10-sends reduces blast radius. |

---

## References

- Master plan: `docs/initiatives/2026-04-23-plan-and-sprints.md`
- Sprint 1 close: `docs/initiatives/SPRINT-1-FINAL.md`
- Test matrix: `docs/initiatives/TEST-COVERAGE-MATRIX.md`
- Migration plans: `services/{campaigns,inbox,relay}/MIGRATION-M*.md`
- BOARD: `docs/handoff/BOARD.md`
