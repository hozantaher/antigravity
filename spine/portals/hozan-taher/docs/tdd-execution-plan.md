# TDD Execution Plan — Critical Path First

> **Generated:** 2026-04-21
> **Based on:** Quick codebase audit (pending full audit by agent)
> **Principle:** Ship first user happy path ASAP, everything else is backlog

---

## Reality Check: What Already Exists

| Component | Status | Notes |
|-----------|--------|-------|
| Dashboard | ✅ DONE | Full page with KPIs, healing log |
| Campaigns list | ✅ DONE | Table + status + actions |
| CampaignDetail | ✅ DONE | KPIs, funnel, sends table, run/pause |
| NewCampaignModal | ✅ DONE (single page) | Name, desc, steps, templates, categories — NOT a 4-step wizard |
| Companies | ✅ DONE | Filters, drawer, scoring, facets |
| Contacts | ✅ DONE | List + drawer |
| Segments | ✅ DONE | QueryBuilder, save/rebuild |
| Templates | ✅ DONE | CRUD + preview |
| Mailboxes | ✅ DONE | 25+ endpoints, warmup, SMTP/IMAP probes |
| Replies/Inbox | ✅ DONE | Filter tabs, classification, handled |
| ThreadDetail | ✅ DONE (basic) | Shows reply + compose textarea + send |
| Analytics | ✅ DONE | KPIs, timeline chart, campaign table |
| Scoring | ✅ DONE | Tier management |
| Watchdog | ✅ DONE | Healing log, daemon status |
| Go thread package | ✅ DONE | Bounce, inbound, messages, manager |
| Go lead/store | ✅ DONE | CRUD + tests |
| Go dns_audit | ✅ DONE | SPF/DKIM/DMARC probes |
| Go web/threads | ✅ DONE | Reply endpoint |
| BFF campaigns | ✅ DONE | CRUD + run/pause + estimate + quality |
| BFF replies | ✅ DONE | List + patch + stats |
| BFF mailboxes | ✅ DONE | 25+ endpoints |
| CommandPalette | ✅ DONE | ⌘K |
| Keyboard shortcuts | ✅ DONE | ShortcutsHelp.jsx |

## MVP Cut-Line: "First Real User Happy Path"

**Definition:** Operator can create campaign → run it → see replies → respond.

**What's already functional for this path:**
1. ✅ Open dashboard → see active campaigns
2. ✅ Create campaign (single-page modal with templates + steps)
3. ✅ Run campaign (run/pause buttons, quality gate data)
4. ✅ See replies (Replies page with tabs + classification)
5. ✅ Read thread (ThreadDetail with reply body)
6. ✅ Respond (compose textarea + send)

**The happy path ALREADY WORKS.** The 4-step wizard is a UX improvement, not a blocker.

## What Actually Needs Work

### Tier 1: Must Fix (blocks confidence in existing features)
1. **Failing tests** — 31 unit tests fail, 348 integration test files fail without server
2. **Build clean** — verify `pnpm build` works
3. **Test infrastructure** — vitest.config.ts cleanup (exclude integration tests from unit run)

### Tier 2: Missing for Production (blocks real deployment)
4. **BFF authentication** — currently zero auth, anyone can hit all endpoints
5. **Error handling standardization** — all errors are 500 with stack traces
6. **TLS validation** — `rejectUnauthorized: false` in SMTP/IMAP
7. **FAULT_INJECT_ALLOWED** — must be disabled in prod

### Tier 3: UX Improvements (nice-to-have, improves operator experience)
8. **CampaignNew → 4-step wizard** — existing modal works, but stepper is better UX
9. **ThreadView timeline rebuild** — basic works, but full chronological timeline is better
10. **Quality gate modal** — data endpoints exist, just need the modal UI
11. **Nav badge** — unhandled reply count in sidebar
12. **Analytics date ranges** — existing shows 7d/14d/30d, add custom picker
13. **Inbox search** — may already work, verify

### Tier 4: New Features (post-MVP)
14. Lead management (Go + UI)
15. Attachment support (MIME parsing + upload)
16. A/B subject testing
17. Best time to send heatmap
18. Template ranking
19. Reply threading headers (In-Reply-To + References)

---

## Critical Path (Topological Sort)

### PHASE 0: Foundation (est. 1 day)

```
CP-001  Fix test infrastructure (setup.js URL patch)           [DONE]
CP-002  Align vitest.config.ts (exclude integration tests)     [10m]
CP-003  Add missing MSW handlers to setup.js                   [30m]
CP-004  Verify: pnpm test (unit only) = 0 failures             [10m]
CP-005  Verify: pnpm build = clean                              [10m]
  ── INTEGRATION GATE 1: pnpm test && pnpm build ──
```

### PHASE 1: Security Hardening (est. 1 day)

```
CP-006  RED: auth contract test (401 without key)               [15m]
CP-007  RED: auth contract test (200 with key)                  [10m]
CP-008  RED: health exempt from auth                            [10m]
CP-009  GREEN: auth middleware in server.js                      [30m]
CP-010  RED: error format contract (400/404/409/500)            [30m]
CP-011  GREEN: error middleware in server.js                     [30m]
CP-012  GREEN: enable TLS validation in SMTP/IMAP probes        [20m]
CP-013  GREEN: disable FAULT_INJECT_ALLOWED in prod             [10m]
CP-014  RED: secrets scan passes                                [10m]
  ── INTEGRATION GATE 2: auth works, errors consistent, TLS on ──
```

### PHASE 2: Test Coverage for Existing Features (est. 2 days)

```
CP-015  RED: Campaigns.test.jsx — list, status, create          [30m]
CP-016  RED: CampaignDetail.test.jsx — KPIs, run/pause          [30m]
CP-017  RED: Replies.test.jsx — tabs, filter, handled            [15m] (may exist)
CP-018  RED: ThreadDetail.test.jsx — load, compose, send         [30m]
CP-019  RED: Inbox.test.jsx — thread list, search                [30m]
CP-020  RED: Analytics.test.jsx — KPIs, timeline                 [15m] (may exist)
CP-021  RED: Watchdog.test.jsx — events, status                  [15m] (may exist)
CP-022  RED: Templates.test.jsx ��� CRUD                           [20m]
  ── INTEGRATION GATE 3: all critical pages have tests, pnpm test clean ──

CP-023  RED: BFF contract — campaigns CRUD                       [30m]
CP-024  RED: BFF contract — replies list + patch                 [20m]
CP-025  RED: BFF contract — mailboxes CRUD + health              [30m]
CP-026  RED: BFF contract — segments CRUD + preview              [20m]
CP-027  RED: BFF contract — templates CRUD                       [15m]
CP-028  RED: BFF contract — health endpoints                     [15m]
  ── INTEGRATION GATE 4: BFF contract coverage ≥75% ──

CP-029  RED: Go — thread lifecycle test                          [20m]
CP-030  RED: Go — campaign lifecycle test                        [20m]
CP-031  RED: Go — bounce cascade test                            [20m]
CP-032  RED: Go — reply classification test                      [20m]
CP-033  RED: Go — warmup/rate limit test                         [20m]
  ── INTEGRATION GATE 5: go test ./... clean, coverage ≥85% business ─���
```

### PHASE 3: Quality Gate Modal (est. 0.5 day)

```
CP-034  RED: QualityGateModal.test.jsx — opens on Spustit       [15m]
CP-035  RED: QualityGateModal.test.jsx — email quality section   [15m]
CP-036  RED: QualityGateModal.test.jsx — capacity section        [15m]
CP-037  RED: QualityGateModal.test.jsx — DNS check section       [15m]
CP-038  GREEN: QualityGateModal.jsx component                    [45m]
CP-039  GREEN: Wire into CampaignDetail "Spustit" button         [15m]
  ── INTEGRATION GATE 6: quality gate blocks unsafe launches ──
```

### PHASE 4: ThreadView Improvements (est. 1 day)

```
CP-040  RED: ThreadView.timeline.test.jsx — chronological order  [15m]
CP-041  RED: ThreadView.timeline.test.jsx — message type styling [15m]
CP-042  RED: ThreadView.context.test.jsx — sidebar company info  [15m]
CP-043  GREEN: Message bubbles (AutoSend, Incoming, Outgoing)    [30m]
CP-044  GREEN: Chronological timeline layout                     [30m]
CP-045  GREEN: Contact context sidebar (70/30 split)             [30m]
  ── INTEGRATION GATE 7: ThreadView shows full conversation ──
```

### PHASE 5: CampaignNew Wizard Upgrade (est. 1 day)

```
CP-046  RED: CampaignNew.stepper.test.jsx — 4 steps             [15m]
CP-047  RED: CampaignNew.stepper.test.jsx — navigation           [15m]
CP-048  RED: CampaignNew.stepper.test.jsx — validation           [15m]
CP-049  GREEN: Refactor NewCampaignModal → 4-step stepper        [1h]
CP-050  GREEN: Step 3: segment picker integration                [30m]
  ── INTEGRATION GATE 8: wizard creates campaign end-to-end ──
```

### PHASE 6: Nav Badge + Inbox Polish (est. 0.5 day)

```
CP-051  RED: NavBadge.test.jsx — shows unhandled count           [15m]
CP-052  GREEN: Badge in sidebar                                  [15m]
CP-053  RED: Inbox search test                                   [10m]
CP-054  GREEN: Search with debounce (if not exists)              [15m]
  ── INTEGRATION GATE 9: inbox + badge + search work ──
```

### PHASE 7: E2E (est. 0.5 day)

```
CP-055  RED: campaign-lifecycle.spec.ts — create → run → pause   [30m]
CP-056  RED: inbox-flow.spec.ts — open → filter → handle         [30m]
CP-057  GREEN: Implement both E2E tests                          [1h]
  ── INTEGRATION GATE 10: E2E green, full happy path verified ���─
```

### PHASE 8: Production Deploy (est. 0.5 day)

```
CP-058  Smoke test against staging                               [15m]
CP-059  Security checklist sign-off                              [30m]
CP-060  Deploy to Railway                                        [30m]
CP-061  Verify health endpoints in production                    [10m]
  ── FINAL GATE: Platform live ──
```

---

## Integration Gates

| Gate | When | Check | Blocker? |
|------|------|-------|----------|
| IG-1 | After Phase 0 | `pnpm test && pnpm build` = 0 errors | YES |
| IG-2 | After Phase 1 | Auth + errors + TLS + no fault inject | YES |
| IG-3 | After Phase 2a | All page tests pass | YES |
| IG-4 | After Phase 2b | BFF contract coverage ≥75% | YES |
| IG-5 | After Phase 2c | `go test ./...` clean | YES |
| IG-6 | After Phase 3 | Quality gate blocks unsafe launch | NO (soft) |
| IG-7 | After Phase 4 | ThreadView full conversation | NO (soft) |
| IG-8 | After Phase 5 | Wizard end-to-end | NO (soft) |
| IG-9 | After Phase 6 | Inbox polish | NO (soft) |
| IG-10 | After Phase 7 | E2E happy path green | YES |
| FINAL | After Phase 8 | Production smoke test | YES |

**Hard gates (IG-1, IG-2, IG-3, IG-4, IG-5, IG-10, FINAL):** Must pass before continuing.
**Soft gates (IG-6 through IG-9):** Can skip for initial deploy, come back later.

---

## Post-MVP Backlog (after FINAL gate)

| Priority | Feature | Est |
|----------|---------|-----|
| P1 | Reply attachments (MIME parse + upload) | 2d |
| P1 | Reply threading headers (In-Reply-To, References) | 1d |
| P2 | Lead management (auto-mark + UI) | 1.5d |
| P2 | Analytics date ranges + CSV export | 0.5d |
| P3 | A/B subject testing | 2d |
| P3 | Best time to send heatmap | 1.5d |
| P3 | Template ranking | 1d |
| P4 | Performance optimization (bundle, queries) | 1d |

---

## Task Count: 61 critical path tasks

**vs. original 600 tasks.** Reduction: ~90%.

Why: most features already exist. The work is mostly:
1. Fix test infrastructure (Phase 0)
2. Add security (Phase 1)
3. Write tests for existing code (Phase 2)
4. One new component (QualityGateModal, Phase 3)
5. Enhance two existing pages (ThreadView, CampaignNew, Phases 4-5)
6. E2E + deploy (Phases 7-8)

---

## Sonnet Execution Instructions

For each CP-NNN task:
1. Read the task description
2. If RED: write the test, run it, verify it fails
3. If GREEN: write minimal implementation, run tests, verify pass
4. Commit after each RED and each GREEN
5. At integration gates: run the full check command
6. If gate fails: fix before proceeding

Start with CP-002. Tasks CP-001 is already done (setup.js URL patch).
