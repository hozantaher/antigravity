---
status: draft (awaiting operator decision)
date: 2026-05-28
trigger: North Star 30s rule — every widget answers Komu psát / Kdo psal / Co je zlomené
---
# Home widget audit — iter 48

## Tally
- Total widgets: 8 (4 inline cards + 3 imported components + 1 metrics strip)
- KEEP: 4   MERGE: 2   MOVE: 1   DELETE: 1
- Estimated row reduction: from ~8 card rows to ~5 card rows; MetricsStrip absorbed into surviving cards

## Inventory + recommendation

| # | Widget | File | Headline | Question | Data freshness | Recommendation | Why |
|---|--------|------|----------|----------|----------------|----------------|-----|
| 1 | `CampaignCard` | `Home.jsx` | "Kampaň {id} — {name}" | A — Komu psát (engine running?) | real-time (30s) | **KEEP** | Single most-actionable card: send rate + pause/resume CTA. Sole owner of campaign state on Home. |
| 2 | `RepliesCard` | `Home.jsx` | "Nezpracované odpovědi" | B — Kdo psal mně | real-time (30s) | **KEEP** | Count + 3 recent previews + direct link. Answers B cleanly with zero duplication. |
| 3 | `MailboxesCard` | `Home.jsx` | "Stav schránek" | C — Co je zlomené | real-time (30s) | **MERGE** → into `LiveClusterRateWidget` | Shows active/paused/auth_locked counts + avg_score. `LiveClusterRateWidget` already renders per-mailbox stuck status. Together they duplicate the "are mailboxes OK?" question. Merge: keep pill summary in Cluster card; drop standalone card. |
| 4 | `NotificationsCard` | `Home.jsx` | "Notifikace" | C — Co je zlomené | real-time (30s) | **KEEP** | Only widget surfacing `mailbox_alerts` + critical system notifications. Distinct from mailbox health; severity escalation path is unique. |
| 5 | `VerifyQueueWidget` | `src/components/VerifyQueueWidget.jsx` | "Verify queue" | NONE (maintenance process, not operator action) | real-time (30s) | **MOVE-TO-VICE** | Verify cron progress is a background maintenance signal, not a daily-decision driver. Operator acts on it at most once a day when stuck. Move to `/priprava` where its CTA already points. |
| 6 | `YesterdaySummaryWidget` | `src/components/YesterdaySummaryWidget.jsx` | "Včera ({date})" | NONE (historical context, no today-action) | daily (hourly refresh) | **MERGE** → into `MetricsStrip` | Sent / Replies / Bounces + reply rate duplicates the MetricsStrip (same three numbers with 24h scope). Trend pill is the only unique element; move it into an expanded strip row. |
| 7 | `LiveClusterRateWidget` | `src/components/LiveClusterRateWidget.jsx` | "Cluster live" | C — Co je zlomené | real-time (30s) | **KEEP** (+ absorb MailboxesCard pills) | Per-mailbox stuck indicator + cluster rate is the fastest engine-stall signal. No duplication after MailboxesCard is merged in. |
| 8 | `MetricsStrip` | `Home.jsx` | "Dnešní metriky" (aria-label) | NONE alone — context strip | real-time (30s) | **DELETE** (or absorb into cards) | Five isolated numbers with no action or threshold colouring except bounce rate and reputation. Bounce rate is already in `LiveClusterRateWidget`; reputation/avg_score in `MailboxesCard`. Strip adds real estate cost for zero new decisions. Merge the coloured values into their parent cards and remove the strip. |

## Render order + approximate vertical real estate (current)

1. Header greeting + clock — ~1 row
2. 2×2 card grid (CampaignCard, RepliesCard, MailboxesCard, NotificationsCard) — ~6 rows combined
3. VerifyQueueWidget (grid item 5) — ~5 rows (progress bar + 4 metric lines + CTA)
4. YesterdaySummaryWidget (grid item 6) — ~4 rows (3-col numbers + trend + CTA)
5. LiveClusterRateWidget (grid item 7) — ~6 rows (rate bar + meta + per-mailbox list)
6. MetricsStrip — ~2 rows

Total: ~24 content rows before scroll on a standard 1440px viewport.

After recommended changes (KEEP 4, absorb 2 into kept cards, remove strip):

1. Header — 1 row
2. 3-card grid (CampaignCard, RepliesCard, NotificationsCard) + expanded LiveClusterRateWidget — ~5 rows each
3. No strip

Estimated reduction: ~24 → ~14 rows. Operator reaches the fold without scrolling on a 900px-height screen.

## Top 3 simplification moves

1. **Delete MetricsStrip** — the five numbers are either already shown inside other cards (bounce rate in LiveClusterRateWidget, avg_score in MailboxesCard) or are pure vanity counts (sent_24h appears in CampaignCard and YesterdaySummaryWidget). Removing it collapses ~2 rows with zero information loss after duplicates are merged. File: `Home.jsx` lines 443 + `MetricsStrip` function (lines 267–320).

2. **Merge MailboxesCard into LiveClusterRateWidget** — both answer "are mailboxes OK?". Pill summary (active / paused / auth_locked counts) fits in two lines inside the Cluster card header area, then the existing per-mailbox rows show granular detail. Eliminates one full 360px card from the grid. Files: `Home.jsx` `MailboxesCard` (lines 187–225) + `src/components/LiveClusterRateWidget.jsx`.

3. **Move VerifyQueueWidget to `/priprava`** — its CTA already says "Otevřít nastavení verify-loop → /priprava". It is a background maintenance process check, not a daily operator-decision driver. Moving it collapses ~5 card rows from Home with no loss to the 30s scan budget. File: `src/components/VerifyQueueWidget.jsx`; remove import + render from `Home.jsx` lines 33, 432–435.

## Secondary move (lower impact)

4. **Merge YesterdaySummaryWidget trend pill into CampaignCard** — the three big numbers (sent/replies/bounces) duplicate MetricsStrip (which is being deleted) and CampaignCard's own `sent_24h` / `bounced_24h`. The only unique element is the day-over-day trend pill. That pill can appear as a small indicator inside CampaignCard's metric row. File: `src/components/YesterdaySummaryWidget.jsx`; remove as standalone Home card.

## Open questions for operator

1. **Verify queue visibility**: if the verify cron stalls overnight, would the operator prefer a compact "stuck" badge inside the NotificationsCard (surfaced via `mailbox_alerts`) rather than a dedicated card on Home? That would mean moving `VerifyQueueWidget` to `/priprava` but still propagating `status_reason='stuck'` as a notification.

2. **Yesterday trend pill**: the `vs_baseline.trend` signal in `YesterdaySummaryWidget` is the only day-over-day comparison on Home. Is it worth keeping as a standalone widget if the three numbers are removed? Or is the trend pill enough to embed inline in CampaignCard?

3. **MetricsStrip deletion vs. collapsible**: the strip currently shows `bounce_rate_pct` with threshold colouring. If it is removed, the bounce rate only appears inside LiveClusterRateWidget (last 60 min window). Is the 24h bounce rate used in operator incident triage? If yes, it should survive as a single labelled metric inside the Cluster card rather than disappearing entirely.

4. **Grid after merge**: with 3 primary cards + 1 expanded Cluster card the grid becomes asymmetric (3 + 1 wide). Should the Cluster card span full width (colspan 2) to visually separate it from the three action cards? This is a layout question, not a widget-count question.
