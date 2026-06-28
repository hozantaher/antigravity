---
status: active
date: 2026-05-29
trigger: "session synthesis — 8-agent verification workflow (w289ta244) re-derived live Galton coefficients + proved what actually landed (feedback_verify_agent_self_report T0)"
owner: Hozan Taher (solo CZ B2B asset-acquisition operator)
supersedes: docs/initiatives/2026-05-29-master-plan-v2.md
method: Workflow-verified (604k tokens, 8 agents, 233 tool-uses) — every claim has git/psql evidence
---

# MASTER PLAN v3 (verified) — Hozan Outreach Dashboard

> v3 differs from v2 because a verification workflow proved several v2 assumptions FALSE.
> Read §2 "Verified corrections" before acting on anything.

## 1. Live Galton snapshot (measured 2026-05-29, PROD)

11-peg acquisition funnel. Hozan = asset buyer (positive reply = firma chce PRODAT stroj). Target 4-6 deals/měsíc.

| Peg | Coefficient | Status |
|---|---|---|
| 1 Targeting | 405,591 contacts (4,470 active 30d) | ✓ (prospect_score RE-VERIFY — likely populated post AV-F5-A) |
| 2 Send | 5,466/5,826 sent = 93.82%, presend_skip 5.22%, failed 2 | ✓ |
| 3 Deliver | bounce 0.93% (pre-cliff 2.78% → post 0.18%) | ✓ deliverability IMPROVED |
| 4 Open | — | ⚠ UNTRACKED (extend FUN-1 funnel_events 'opened') |
| 5 Read | — | ⚠ UNTRACKED (likely infeasible w/o click-redirect) |
| 6 Reply | **0.66%** (pre-cliff 0.73% → post 0.26%) | ❗ **THE BOTTLENECK −66% vs 2-4% benchmark** |
| 7 Classify | positive 15, question 6, negative 11, unsub 2, null 2 | ◐ (2 null = no body) |
| 7.5 Hot leads | **21** (58.33% of replies actionable), send-to-hot 0.38% | ✓ downstream quality strong |
| 8 Asset Eval | — | ⚠ NOT_IMPLEMENTED (vehicles surface exists unmerged) |
| 9 Phone | — | ⚠ TRUE GAP |
| 10 Offer | — | ⚠ TRUE GAP |
| 11 Pickup/Resell | — | ⚠ UNTRACKED (maps to vehicle status) |

**Mailbox reply variance 1.8×:** 77=0.52%, 76=0.46%, 78=0.29%, 75=0.29%.

### THE CLIFF — workflow diagnosis CORRECTED (2026-05-29, inline verification)
**The workflow's "subject line" diagnosis was a MISDIAGNOSIS. Do NOT revert subject.**

Verified step×subject: `Dotaz` = **step 0 (first touch)**, `Poptávka` = **step 1 (follow-up)** — NOT A/B variants. step0 Dotaz 0.48% (19/3993), step1 Poptávka 0.20% (3/1489). Follow-ups naturally yield less; comparing them is apples-to-oranges. Reverting "Poptávka→Dotaz" would break the follow-up step.

**The real cliff:** after 2026-05-19 reply ingestion went to ZERO across BOTH steps. step-0 Dotaz first-touch volume actually ROSE post-cliff (123/219/210 sends on 20-22.5.) yet produced 0 replies (0.48% would predict ~2-3). reply_inbox MAX(received_at)=2026-05-19. All 4 mailboxes unseen=0 on IMAP.

**Candidate causes (needs probe, not DB-only):**
1. Deliverability / spam-folder placement — SMTP 250 success but inbox-miss (bounce improved, but spam-placement ≠ bounce)
2. Reply ingestion / IMAP attribution broke post-19.5 (but G3 showed poll healthy, unseen=0)
3. Genuine recipient non-response (cohort fatigue / seasonal)

**Bottleneck verdict:** PEG6_REPLY confirmed (-66% vs benchmark), but the lever is NOT subject. P0-FAST (subject revert) is **CANCELLED**. The real Phase-0/2 work is a cliff diagnosis: external inbox-placement probe + IMAP ingestion audit post-19.5. The step-1 follow-up at 0.20% is a separate, lower-priority optimization (normal follow-up yield).

## 2. Verified corrections (v2 assumptions proven FALSE)

| v2 claimed | Verified reality |
|---|---|
| Consolidate via branch merge | **MERGE DELETES migration 128 + inbound.go body code.** Siblings (hover-preview, historical-backfill, FUN-1) share pre-G3 ancestor c4412157. `git diff HEAD..hover-preview` = 688 ins / **2041 DEL**. Consolidation = per-commit cherry-pick of net-new ONLY. |
| Galton widget = new /api/galton/funnel | **FUN-1 already shipped** funnel_events (migration 141) + /api/funnel/summary + AnalyticsFunnelTab.jsx + **6,472 backfilled PROD rows**. Widget CONSUMES it. |
| Auto-classify event-driven NOT coded | **feat/lead-conveyor-realtime-classify** (LISTEN/NOTIFY 30s) ALREADY CODED. |
| ≥0.85 auto-commit NOT coded | **feat/ux-18-auto-execute-high-confidence** ALREADY CODED. |
| Automation 0 implemented | **9 crons already wired** (autoclassify, watchdog, bounce-throttle, health-cycle, bounce-flip, greylist-retry, lifecycle, anomaly, prospect-scoring). |
| 4 MERGEs / distillation pending | rollup-v2 ALREADY did HighRiskDomainsCard, SendRate+ActiveCampaigns, M3 histogram, freshness 3→1. |
| PEG8 asset-eval net-new | vehicles CRUD (Vehicles.jsx + vehicles.js, AU-F1/F2) exists on unmerged branches. |
| prospect_score NULL/inert | likely STALE — AV-F5-A scoring merged, cron wired. Re-query. |

## 3. Data-integrity blockers (must clear before features render)

1. **body_text 0/36** — backfill cmd is **UNTRACKED working-tree main.go (941 LOC), not committed, not run**
2. 2/36 replies unclassifiable until body backfilled
3. classifier silently on 0.3-confidence: `channel_messages` LEFT JOIN target **has NO creating migration** → repoint to `reply_inbox.body_text`
4. **STRAY ARTIFACT**: `features/inbound/orchestrator/backfill-reply-bodies` = untracked compiled Mach-O arm64 ~10MB — rm + gitignore (never commit) [cross-ref .railwayignore size guard]
5. 5 untracked iter54 Playwright specs (story-16..20) — commit into consolidation or discard
6. main @ bde1cd2f — **zero session work merged**

## 4. Roadmap — 5 phases (dependency-corrected)

### PHASE 0 — Data lock-in + reconciliation + visibility
Goal: trustworthy funnel data ON main; 3-way reconcile siblings WITHOUT reverting G3.7; run backfill; fix classifier; ship cliff fast-path.

- **P0-S2** Commit backfill cmd + clean artifacts (FIRST) — `deps: []`
  - S2.1 land main.go as tracked code before running it
  - S2.2 rm stray Mach-O binary + gitignore build output
  - S2.3 home/discard 5 untracked iter54 specs
  - S2.4 backfill runbook in docs/playbooks/
- **P0-S3** Repoint classifier channel_messages → reply_inbox.body_text — `deps: []`
  - S3.1 confirm table/trigger absence (read-only)
  - S3.2 repoint replyClassifyEndpoint.js (lands in consolidation — mutates G3.5 a6eabeb8)
- **P0-S1** Run historical body backfill — `deps: [P0-S2]`
  - S1.1 `go run ./cmd/backfill-reply-bodies --dry-run` (SOCKS5-only, zero writes)
  - S1.2 live run w/ operator consent (body_text 0→≥18, audit-log per row, backoff)
  - S1.3 re-classify 2 null replies after repoint → 36/36
- **P0-FAST** ~~Subject cliff revert~~ **CANCELLED** — misdiagnosis (Poptávka = step-1 follow-up, not a variant). Replaced by:
- **P0-CLIFF** Post-19.5 zero-reply diagnosis — `deps: []` (read-only + external probe)
  - CLIFF.1 IMAP ingestion audit: confirm unseen=0 is real (no replies arriving) vs poll-attribution gap post-19.5
  - CLIFF.2 external inbox-placement probe (send canary to seznam/gmail test addr, check spam vs inbox) — anti-trace-safe, operator may need to eyeball
  - CLIFF.3 cohort analysis: post-19.5 contacts vs pre — segment/source/geo shift?
- **P0-S4** 3-way reconciliation to main — `deps: [P0-S1, P0-S2, P0-S3]`
  - S4.1 cherry-pick net-new ONLY: 95245f58+450ff583+b7afbd58 (hover) + dd2114db (FUN-1), resolve inbound.go in favor of HEAD's G3.7.2
  - S4.2 **prove G3.7.1/G3.7.2 survived** (psql \d reply_inbox body cols + grep inbound.go + migrations 126/127/128 present)
  - S4.3 gate: node --check + pnpm test:fast + operator-strict smoke
  - S4.4 merge to main + restart BFF + include stranded audit-log T0 fix (2f34ee39)

### PHASE 1 — Galton funnel Home widget (on FUN-1) + reply body surface
- **P1-G0** Galton widget = rendering layer on FUN-1 `/api/funnel/summary` (HIGHEST-VALUE) — `deps: [P0-S4]`
  - G0.0 reuse FUN-1 endpoint, NO new /api/galton/funnel
  - G0.1 extend summary with 11-peg framing + coefficients
  - G0.2 Home widget renders pegs + names PEG6 bottleneck
  - G0.3 cliff annotation (data-driven)
  - G0.4 Playwright smoke
- **P1-S5a** reply body BFF (confirm 95245f58 landed) — `deps: [P0-S1, P0-S4]`
- **P1-S5b** hover-preview UI (confirm 450ff583 landed) — `deps: [P1-S5a]`
- **P1-S5c** hover smoke verification (b7afbd58) — `deps: [P1-S5b]`

### PHASE 2 — Reply rate recovery (attack the bottleneck)
- **P2-S1** subject-variant operator control + viz — `deps: [P1-G0, P0-FAST]`
- **P2-S2** per-mailbox reply-rate health (flag 75/78) — `deps: [P1-G0]`
- **P2-S3** open tracking PEG4 — EXTEND funnel_events 'opened', not parallel schema — `deps: [P1-G0]`

### PHASE 3 — Distillation backlog + automation RECONCILIATION
- **P3-S0** automation inventory (mark ALREADY-CODED/PARTIAL/TRUE-GAP) — `deps: [P0-S4]`
- **P3-S1** audit MERGE/MOVE (re-baselined vs rollup-v2; verify audit doc exists) — `deps: [P0-S4]`
- **P3-S2** TRUE automation gaps + merge LEAD-1/UX-18 — `deps: [P3-S0, P1-S5a]`
  - stalled-watchdog, failed-send retry, warmup catch-up, Ollama-down alert, reconcile lead family
- **P3-S3** T0 magic-threshold remediation (corrected path: runCampaignWatchdogCron.js, NOT server-routes) — `deps: [P0-S4]`

### PHASE 4 — Post-reply pipeline pegs 8-11 (reconcile vehicles/lead/ACQ-1)
- **P4-S0** inventory vehicles + lead branches + ACQ-1; map funnel_events lead_* → pegs — `deps: [P1-G0, P0-FAST]`
- **P4-S1** PEG8 asset-eval (reuse vehicles status), PEG9 phone + PEG10 offer (TRUE gaps), PEG11 resell — `deps: [P4-S0, P2-S1]`

## 5. Immediate actions (exact order)

1. **Commit backfill cmd FIRST** (`git add cmd/backfill-reply-bodies/main.go` + build) + **rm stray Mach-O binary** + gitignore — reverses the fragile "run untracked tool against PROD" order.
2. **Dry-run** from tracked source (SOCKS5-only, 0 writes), then **live** w/ consent (0→≥18, audit per row).
3. **Repoint classifier** channel_messages → reply_inbox.body_text (lands in consolidation).
4. **Decide subject revert NOW** (P0-FAST) — #1 bottleneck fix during active zero-reply state.
5. **Consolidation = 3-way cherry-pick of net-new ONLY** (NOT merge — proves migration 128 survives).
6. **Galton widget = rendering layer on FUN-1** (no new endpoint).

## 6. Open operator questions (real decisions)

1. **Run body backfill against PROD now?** 18-22 IMAP fetches via SOCKS5, 2s spacing, writes reply_inbox. Older Seznam UIDs may be expired (lost forever).
2. **Revert default subject 'Poptávka'→'Dotaz'?** Content/business call. −64% verified. Given 10-day zero-reply state, earliest remediation.
3. **Pause sending until subject fix ships, or accept the zero-reply window?**
4. **Pause or warm-up mailboxes 75 & 78?** (0.29% vs 0.52%/0.46%) — warmup lag or reputation damage?
5. **Consolidation strategy** — confirm 3-way cherry-pick of net-new vs rebasing siblings onto HEAD first.
6. **FUN-1 reuse** — confirm Galton widget consumes /api/funnel/summary, inbound.go resolved in favor of HEAD.
7. **Automation** — confirm merge/verify LEAD-1 + UX-18 (+ lead family) rather than re-implement.
8. **Vehicles/Phase-4** — confirm reconcile unmerged vehicles surface for PEG8/11.
9. **PEG1** — re-query prospect_score population before treating as inert.
10. **Open tracking (PEG4)** — does operator want open-pixel at all (industry-standard B2B MarTech)?
11. **Locate the cited cross-page-distillation audit doc** — NOT found on disk; correct citation before P3-S1.

## 7. Pillar scorecard

| Pillar | State |
|---|---|
| Napojení | ◐ G3 done; body backfill + consolidation pending |
| Automatizace | ◐ 9 crons + LEAD-1/UX-18 coded; reconcile + 4 true gaps |
| Editovatelnost | ◐ 6 ALLOWED_KEYS done; watchdog thresholds + env knobs pending |
| Komplexnost | ◐ per-mailbox/variant/day dimensions in P2 |
| Jednoduchost | ◐ 11 widgets removed; Galton widget = the consolidation |
| Těžba | ◐ funnel_events 6472 rows; body backfill unlocks asset-eval |
| Traceability | ◐ 16-col reply_inbox; body_text 0/36 until backfill |
