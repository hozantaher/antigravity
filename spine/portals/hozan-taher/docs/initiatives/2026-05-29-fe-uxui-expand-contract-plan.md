---
status: active
date: 2026-05-29
trigger: "operator — focus FE/UX/UI, expand-then-contract (generate 100×, then distill)"
method: expand-then-contract — 10 parallel generators × ~10 grounded candidates → contract/dedup/score
source_workflow: wgved0vzb (11 agents, 869k tokens) — 124 raw → 78 deduped → 23 shipped + 12 rejected
constraints: Signal-Desktop aesthetic (tokens-claude.css --c-*), 30s rule, pillars, no new heavy deps
---

# FE/UX/UI Expand-then-Contract Plan

Every candidate is grounded in real code (claude-context + Read). Aesthetic +
30s-simplicity are hard constraints. Done items struck through.

## Quick wins (S effort)
1. ~~Skip-to-main link (WCAG 2.4.1)~~ ✅ DONE (Layout.jsx + .skip-link CSS) — verified Tab→visible
9. ~~Home recent-reply subject truncate + title tooltip~~ ✅ DONE (Home.jsx:176)
2. Placeholder/muted-text contrast → AA — **RE-CHECK**: `--muted` #6E6E73 ≈ 4.69:1 already passes; real violations are `--c-text-soft` #8E8E93 (~3.5:1) used as meaningful text. Audit those sites (needs real axe run, not eyeball).
3. ~~Disabled-button cursor:not-allowed~~ REDUNDANT — `.btn:disabled` (index.css:463) already has opacity .4 + cursor:not-allowed. Real gap: inline-styled disabled buttons (e.g. VehicleDetail pipeline) bypass `.btn`.
4. Warmup-paused visual state (opacity + cross-hatch) — MailboxRow.jsx:154 + index.css
5. Empty-state: "no campaigns" vs "filtered out" distinction — Campaigns.jsx:566
6. Bulk "Označit jako čtené" button (read w/o classify; key `A` already wired) — RepliesActionBar.jsx:71
7. Classification badge beside contact name (not right-rail) — DetailAnchorHeader.jsx:60
8. Focus-visible ring sweep: checkboxes + sort-th — index.css:753,1994
10. Consolidate `#6c757d`/badge color drift to tokens — Home.jsx, StatusBadge.jsx (partly addressed by #9's var(--c-text-muted))

## High-impact (M/L)
11. Auto-collapse sidebar <480px (244px eats 65% of phone) — index.css + Layout.jsx
12. Touch: show RepliesRow actions inline (`hover:none`) — RepliesRow.jsx + index.css
13. **Margin column in vehicles table** (agreed−offered, color-coded) — VehiclesTableRow.jsx:197, VehiclesTable.jsx:31 — high employee value
14. Status pipeline visual stepper (done/active/upcoming) — VehicleDetail.jsx:111
15. Migrate Home inline button/alert styles → CSS w/ hover+focus+disabled — Home.jsx
16. Funnel bottleneck label emphasis — AnalyticsFunnelTab.jsx:14
17. Template comparison sortable columns — AnalyticsFunnelTab.jsx:183
18. VehicleCaptureModal candidate-card dropdown w/ facts inline — VehicleCaptureModal.jsx:180
19. Mobile responsive Replies + Companies tables — index.css
20. Mailbox drawer focus trap + Esc — MailboxDrawer.jsx:40
21. Popover Esc restores focus to trigger — RepliesFilterPopover.jsx:50
22. Auto-refresh campaign stats while running — Campaigns.jsx:334
23. Reply row height 56→50px (more rows/screen) — RepliesTableRow.jsx:70

## Rejected (anti-Signal / over-engineered / unverifiable)
Modal-backdrop-close (already works Modal.jsx:71), tactile backdrop feedback,
column-resize drag, margin sparkline, vehicle photo (no backend field),
bounce sparkline (density vs 30s), 4-tier health band, beacon pulse, drawer
cascade animation, MessageBubble tip toast, Home recent-reply hotkey,
custom select replacement (regression risk).

## Next batch (recommended order)
After #1/#9 (done): #13 margin column, #6 bulk-read button, #7 badge reposition,
#20/#21 focus-trap+Esc (a11y), #11/#12/#19 mobile (employee may use phone).
