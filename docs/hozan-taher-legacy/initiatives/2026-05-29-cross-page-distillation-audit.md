---
status: draft (awaiting operator decision)
date: 2026-05-29
trigger: North Star 30s rule — extend Home audit to remaining routes
related: docs/initiatives/2026-05-28-home-widget-audit.md
---
# Cross-page distillation audit — iter 50

**North Star working assumption:**
> Solo CZ obchodník otevře dashboard a do 30 sekund ví CO udělat — koho oslovit (A), kdo odpověděl (B), co je zlomené (C). Method = destilace (subtract until you can't).

**Classification key:**
- A — koho oslovit (prospect pipeline)
- B — kdo odpověděl (reply inbox)
- C — co je zlomené (health / blocker)
- NONE — internal / background, no 30s value

---

## Summary tally

| Route | Total widgets | KEEP | MERGE | MOVE | DELETE | Est. row reduction |
|---|---:|---:|---:|---:|---:|---:|
| /replies | 9 | 6 | 1 | 0 | 2 | ~22% |
| /replies/triage | 0 | — | — | — | — | (no separate route) |
| /campaigns | 6 | 4 | 0 | 1 | 1 | ~17% |
| /mailboxes | 11 | 7 | 1 | 1 | 2 | ~27% |
| /priprava | 5 | 3 | 0 | 0 | 2 | ~40% |
| /priprava/top-targets | 5 | 5 | 0 | 0 | 0 | 0% |
| /companies | 6 | 5 | 0 | 1 | 0 | ~17% |
| /leads/:id | 0 | — | — | — | — | redirects to /contacts |
| /analytics/kpi | 6 | 3 | 1 | 1 | 1 | ~33% |
| /analytics/trendy | 6 | 4 | 1 | 0 | 1 | ~17% |
| /analytics/crony | 5 | 4 | 0 | 1 | 0 | ~20% |
| **TOTAL** | **59** | **41** | **4** | **5** | **9** | **~25%** |

---

## Per-route inventory

### /replies

Route file: `features/platform/outreach-dashboard/src/pages/Replies.jsx`

| # | Widget / element | JSX ref | 30s axis | Recommendation | Rationale |
|---|---|---|---|---|---|
| 1 | **RepliesBreadcrumb** — "Inbox · N nezpracovaných" | `Replies.jsx:628` | B | KEEP | Primary orientation — tells operator exactly what needs action |
| 2 | **Stats error banner** — inline alert when /api/replies/stats fails | `Replies.jsx:637` | C | KEEP | Non-blocking error surface, low noise |
| 3 | **RepliesFilters** — search, since-picker, tab selector (Nezpracované / Zájem / Odmítnutí / …), refresh | `Replies.jsx:655` | B | KEEP | Core triage workflow; tabs ARE the content model |
| 4 | **FailedSendsPanel** — "failed_sends" tab content | `Replies.jsx:675` | C | KEEP | Legitimate C signal (send failures), gated behind tab so no visual noise on default view |
| 5 | **RepliesSseBanner** — "N nových odpovědí — zobrazit" banner (page > 1) | `Replies.jsx:787` | B | KEEP | Zero-cost when on page 1; critical UX affordance when triaging mid-stream |
| 6 | **RepliesActionBar** — master checkbox + bulk actions + sort + range label | `Replies.jsx:801` | B | KEEP | Bulk triage is the operator's primary efficiency lever |
| 7 | **RepliesTable** — main reply rows | `Replies.jsx:824` | B | KEEP | IS the page |
| 8 | **RepliesPagination** — page controls + size selector | `Replies.jsx:839` | B | KEEP | Necessary for > 30 replies |
| 9 | **Klávesové zkratky** — collapsible `<details>` shortcut legend | `Replies.jsx:852` | NONE | DELETE | Collapsed by default, duplicated by `?` shortcut → `RepliesShortcutLegend` modal; adds visual weight to a page that needs clean first-paint |

**Note:** `/replies/triage` does not exist as a separate route. The triage surface IS /replies with keyboard shortcuts + the tab bar. No separate route audit needed.

---

### /campaigns

Route file: `features/platform/outreach-dashboard/src/pages/Campaigns.jsx`

| # | Widget / element | JSX ref | 30s axis | Recommendation | Rationale |
|---|---|---|---|---|---|
| 1 | **MissingPasswordBanner** — banner when mailbox has no SMTP password | `Campaigns.jsx:486` | C | KEEP | Canonical C blocker; but note duplication — also rendered on /mailboxes (see Duplications) |
| 2 | **CampaignsLast24hNotice** — notice about campaigns active in last 24h | `Campaigns.jsx:487` | C | KEEP | Legitimate anti-spam awareness signal |
| 3 | **PageHead / PageStatStrip** — "Běží N / Pauza N / Koncept N / Celkem N / Odesláno N / Odpovědí N" | `Campaigns.jsx:488` | A/C | KEEP | 6-number strip that answers "is anything running and how is it doing" in 5s |
| 4 | **ChipGroup / StatusFilter** — Běží / Pauza / Koncept / Dokončené chips | `Campaigns.jsx:525` | NONE | MOVE-TO-VICE | Filter chips are useful only when list is long (>10 campaigns); for current scale they add noise; operator can see all campaigns at a glance in the table; move chips inside the table header when campaign count > 10 |
| 5 | **Campaigns table** — sortable list, per-row pause/play/delete/send-batch | `Campaigns.jsx:576` | A/C | KEEP | IS the page |
| 6 | **SendBatchDialog / PauseAllDialog / NewCampaignModal** — modals | `Campaigns.jsx:655` | A/C | KEEP | On-demand; zero visual cost until triggered |

---

### /mailboxes

Route file: `features/platform/outreach-dashboard/src/pages/Mailboxes.jsx`

| # | Widget / element | JSX ref | 30s axis | Recommendation | Rationale |
|---|---|---|---|---|---|
| 1 | **MailboxesPageHead** — "N aktivní / N pauzováno / celkem N / daily cap N" + "Přidat" button | `Mailboxes.jsx:432` | C | KEEP | C headline — tells operator if the engine can even send anything |
| 2 | **TabBar** — Schránky \| Upozornění | `Mailboxes.jsx:444` | C | KEEP | Clean separation; Upozornění is the /watchdog successor, genuinely separate concern |
| 3 | **MissingPasswordBanner** | `Mailboxes.jsx:460` | C | MERGE | Canonical home for this banner; on /campaigns it is a copy (see Duplications) |
| 4 | **BounceWarningBanner** | `Mailboxes.jsx:461` | C | KEEP | Mailbox-specific C blocker; not shown elsewhere |
| 5 | **System health alert banner** — from `/api/health/system` | `Mailboxes.jsx:462` | C | KEEP | Low noise; only surfaces when alerts.length > 0 |
| 6 | **MailboxHealthBoard** — visual status-icon grid, hidden by default | `Mailboxes.jsx:481` | C | DELETE | Hidden-by-default opt-in with no visible affordance once operator is past onboarding; same information is in the MailboxesTable health column. Adds a localStorage toggle and a separate API call for zero first-paint value. |
| 7 | **MailboxesFilters** — search + status chips + health band + density + refresh | `Mailboxes.jsx:495` | C | KEEP | Necessary for 10+ mailboxes |
| 8 | **Config drift banner** — from `/api/health/drift` | `Mailboxes.jsx:522` | C | KEEP | Only fires on critical drift; genuinely urgent C signal |
| 9 | **AnonymizationBar** — anti-trace + proxy pool + proxy sources status bar | `Mailboxes.jsx:534` | C | KEEP | Critical C signal for send pipeline; Mullvad/SOCKS down = all sends fail silently |
| 10 | **HighRiskDomainsCard** — collapsed `<details>`, admin panel for presend SMTP probe domains | `Mailboxes.jsx:555` | NONE | MOVE-TO-VICE | Advanced operator setting used "when X7 level-2 RCPT probe needs reconfiguring (rare)". Should live on /settings, not on the daily health page |
| 11 | **MailboxesBulkBar + MailboxesTable** — bulk actions + main table | `Mailboxes.jsx:573` | C | KEEP | IS the page |

---

### /priprava

Route file: `features/platform/outreach-dashboard/src/pages/PripravaRana.jsx`

| # | Widget / element | JSX ref | 30s axis | Recommendation | Rationale |
|---|---|---|---|---|---|
| 1 | **3-step StepCard block** — Schránky / Šablony / Segmenty readiness checklist | `PripravaRana.jsx:185` | C | KEEP | Core purpose of the page; one-screen blocker triage before first campaign |
| 2 | **EgressCard** — anti-trace egress sanity (transport mode, wireproxy, egress IP, Mullvad peer) | `PripravaRana.jsx:194` | C | KEEP | Prevents the "silent wrong-country exit" class of incident; belongs here as a pre-launch gate |
| 3 | **VerifikaceAdresCard** — email address verification queue progress | `PripravaRana.jsx:195` | A | DELETE | This is a background enrichment task, not a launch blocker. Operator can view it on /companies. Moving it here inflates the page with a process-status widget that isn't in the 3-step launch checklist. Cross-check: also rendered on Home as `VerifyQueueWidget`. |
| 4 | **TemplatePreviewWidget** — collapsible email preview inside step 2 | `PripravaRana.jsx:295` | NONE | DELETE | Operator can preview templates on /templates. Adding a collapsed preview inside the readiness step creates a "rabbit hole" that delays the check-and-move-on workflow. |
| 5 | **Sector list `<details>`** inside step 3 | `PripravaRana.jsx:461` | NONE | KEEP | Inlined detail within the readiness card; zero visual cost when collapsed; legitimate confirmation that contacts exist |

---

### /priprava/top-targets

Route file: `features/platform/outreach-dashboard/src/pages/TopTargets.jsx`

| # | Widget / element | JSX ref | 30s axis | Recommendation | Rationale |
|---|---|---|---|---|---|
| 1 | **Breadcrumb** — "Příprava › Top targets · N nad skóre 70" | `TopTargets.jsx:278` | A | KEEP | Clear orientation |
| 2 | **TopTargetsStatStrip** — 4-bucket score distribution (Ideální / Vysoký / Střední / Nízký) | `TopTargets.jsx:347` | A | KEEP | Answers "how many ready prospects exist" in 5s |
| 3 | **TopTargetsFilters** — search, sector, region, min-score, with-email toggle | `TopTargets.jsx:353` | A | KEEP | Core targeting workflow |
| 4 | **TopTargetsActionBar** — master checkbox + "Zařadit do kampaně" + range label | `TopTargets.jsx:422` | A | KEEP | Primary CTA for the page |
| 5 | **TopTargetsTable + RepliesPagination** | `TopTargets.jsx:434` | A | KEEP | IS the page |

---

### /companies

Route file: `features/platform/outreach-dashboard/src/pages/Companies.jsx`

| # | Widget / element | JSX ref | 30s axis | Recommendation | Rationale |
|---|---|---|---|---|---|
| 1 | **CompaniesPageHead** — total count, active filter badge, "Spustit kampaň" CTA | `Companies.jsx:22` (import) | A | KEEP | Primary A surface; total count + launch-campaign shortcut is the whole point |
| 2 | **CompaniesFilters** — search + 10-field secondary filter panel (collapsed) | `Companies.jsx:22` (import) | A | KEEP | Necessary for targeting; secondary panel hidden by default |
| 3 | **CompaniesBulkActions** — bulk select + "Spustit kampaň pro výběr" | `Companies.jsx:22` (import) | A | KEEP | B3 feature — launch from row selection |
| 4 | **CompaniesTable** — main table + CompanyDrawer | `Companies.jsx:22` (import) | A | KEEP | IS the page |
| 5 | **ShortcutsHelp** — `?` modal | `Companies.jsx:14` | NONE | KEEP | Zero-cost on-demand reference |
| 6 | **Filter presets** — save/load filter snapshots | `Companies.jsx:12` (useFilterPresets hook) | A | MOVE-TO-VICE | Presets are a power-user feature that belongs inside the filters panel itself, not as a top-level affordance. Currently accessed from the filter row; consider collapsing into a "Uložit filtr" button inside CompaniesFilters rather than a separate component that adds cognitive weight. |

---

### /leads/:id

Route: `features/platform/outreach-dashboard/src/main.jsx:104` — `<Navigate to="/contacts" replace />`

This is a redirect stub. No widgets to audit. The `/contacts` page (Contacts.jsx) is not in the priority list but can be audited as a follow-up if needed.

---

### /analytics (KPI tab)

Route file: `features/platform/outreach-dashboard/src/components/analytics/AnalyticsKpiTab.jsx`

| # | Widget / element | JSX ref | 30s axis | Recommendation | Rationale |
|---|---|---|---|---|---|
| 1 | **"Analytika" PageHead** | `Analytics.jsx:41` | NONE | KEEP | Minimal header |
| 2 | **4 KPI cards** — total sent / replied / opened / bounced + rates | `AnalyticsKpiTab.jsx:140` | C | KEEP | Aggregate health snapshot — valid C surface |
| 3 | **Timeline BarChart** — sent/replied/opened over N days, with custom date range | `AnalyticsKpiTab.jsx:200` (approx) | NONE | MOVE-TO-VICE | The day-to-day trend is useful for weekly retrospective but not for the 30s morning scan. Consider collapsing behind a "Zobrazit trend" toggle; default to the KPI cards only. |
| 4 | **Campaign perf table** — per-campaign reply rate, sortable | `AnalyticsKpiTab.jsx:120` | A/C | KEEP | Answers "which campaign is actually working" — genuine decision support |
| 5 | **Polling indicator + "Aktualizováno před Ns" + manual refresh button** | `AnalyticsKpiTab.jsx:141` | NONE | MERGE | Three elements for one concern (freshness); merge into a single inline timestamp + auto-refresh icon per /replies pattern |
| 6 | **CSV export button** | `AnalyticsKpiTab.jsx:83` | NONE | DELETE | No operator use case documented for CSV export from this surface; adds button to a read-only analytics page |

---

### /analytics (Trendy tab)

Route file: `features/platform/outreach-dashboard/src/components/analytics/AnalyticsTrendsTab.jsx`

| # | Widget / element | JSX ref | 30s axis | Recommendation | Rationale |
|---|---|---|---|---|---|
| 1 | **M1 — Bounce rate panel** per mailbox | `AnalyticsTrendsTab.jsx:55` | C | KEEP | Actionable deliverability signal |
| 2 | **M2 — Spam complaint rate panel** per mailbox | `AnalyticsTrendsTab.jsx:22` (state) | C | KEEP | Critical C signal |
| 3 | **M3 — Delivery-time histogram** | `AnalyticsTrendsTab.jsx:27` (state) | NONE | DELETE | Delivery time is an engineering curiosity, not an operator decision trigger. No documented action if P99 goes up. |
| 4 | **M4 — Blacklist alerts panel** | `AnalyticsTrendsTab.jsx:32` (state) | C | KEEP | Hard C signal — blacklisting = stop sending immediately |
| 5 | **M5 — Composite reputation score** per mailbox + sparkline | `AnalyticsTrendsTab.jsx:36` (state) | C | KEEP | Drives mailbox pause/warmup decisions |
| 6 | **L2 — Template metrics** — per-template reply rate | `AnalyticsTrendsTab.jsx:43` (state) | A | MERGE | Template performance could live in /templates detail view where the operator can act on it immediately; here it's read-only with no adjacent action |

---

### /analytics (Crony tab)

Route file: `features/platform/outreach-dashboard/src/components/analytics/AnalyticsCronsTab.jsx`

| # | Widget / element | JSX ref | 30s axis | Recommendation | Rationale |
|---|---|---|---|---|---|
| 1 | **CronHeartbeatsPanel** — per-daemon last-run time + stale indicator | `AnalyticsCronsTab.jsx:52` | C | KEEP | Critical during incident triage |
| 2 | **Synthetic smoke status grid** | `AnalyticsCronsTab.jsx` (approx) | C | KEEP | Pass/fail at a glance |
| 3 | **BurnRateBadge** — SLO error-budget burn rate | `AnalyticsCronsTab.jsx:41` | C | KEEP | Quantified C signal |
| 4 | **SendRateWidget + ActiveCampaignsLive** | `AnalyticsCronsTab.jsx:16` (import) | C | MOVE-TO-VICE | These are live campaign-level widgets — they belong on the Home or /campaigns page, not buried in the Crony engineering tab. A solo operator opening /analytics?tab=crony for incident triage doesn't need "how many sends/hour right now"; they need heartbeats. |
| 5 | **External diagnostic links** — e.g. Railway logs, Sentry | `AnalyticsCronsTab.jsx` | NONE | KEEP | Zero-cost reference links; valuable during incident |

---

## Top 10 simplification moves (ordered by impact)

1. **DELETE — MailboxHealthBoard — /mailboxes** — Hidden-by-default opt-in widget that duplicates the health column already present in MailboxesTable; removing it eliminates a localStorage toggle, a secondary API call, and 40+ LOC of toggle wiring with zero information loss.

2. **MOVE-TO-VICE — HighRiskDomainsCard — /mailboxes** — Admin-only setting used once per quarter; it belongs on `/settings` not on the daily health page; its presence inflates the mailbox page with an advanced panel the operator must consciously skip every day.

3. **DELETE — TemplatePreviewWidget — /priprava** — Template preview inside the readiness checklist creates a "rabbit hole" (operator opens the preview, spends 5 minutes tweaking wording, forgets to finish the 3-step check); `/templates` is the canonical surface for this.

4. **DELETE — VerifikaceAdresCard — /priprava** — Background enrichment task not a launch blocker; already visible on Home as `VerifyQueueWidget`; its presence on /priprava conflates "am I ready to launch" with "is my enrichment pipeline current".

5. **DELETE — Klávesové zkratky collapsible — /replies** — The `?` keyboard shortcut already surfaces the full `RepliesShortcutLegend` modal; the collapsed `<details>` is a lower-quality duplicate that clutters first-paint below the fold.

6. **DELETE — Timeline BarChart default-visible — /analytics/kpi** — The 30-day send trend is a weekly retrospective tool, not a 30s morning scan item; collapsing it behind a toggle makes the KPI cards (the real 30s content) land above the fold immediately.

7. **MERGE — Polling indicator / "Aktualizováno" / refresh button — /analytics/kpi** — Three separate elements for one concern (data freshness); consolidate into a single "Aktualizováno před Ns · ↺" inline element (pattern already established on /replies).

8. **DELETE — CSV export — /analytics/kpi** — No documented operator use case; analytics page is read-only and the export path (`analytics.csv` blob download) is not wired to any downstream tool; adds a button that could be mistakenly clicked during normal triage flow.

9. **MOVE-TO-VICE — SendRateWidget + ActiveCampaignsLive — /analytics/crony** — Live campaign throughput widgets inside an engineering diagnostics tab confuse the information hierarchy; send-rate belongs on Home or /campaigns where the operator can act on a stall; in Crony it gets lost behind incident-triage content.

10. **MOVE-TO-VICE — StatusFilter chip group — /campaigns** — At current scale (< 10 campaigns) the operator sees all campaigns in one table view; the chip filter adds interactive overhead to a list that doesn't need filtering yet; should auto-show only when campaign count exceeds a threshold (configurable via operator_settings).

---

## Duplications found

| Widget | Routes where rendered | Proposed canonical home |
|---|---|---|
| `MissingPasswordBanner` | `/mailboxes` (line 460), `/campaigns` (line 486) | `/mailboxes` — that IS the mailbox management surface; remove from /campaigns |
| `VerifyQueueWidget` / `VerifikaceAdresCard` | `/` (Home, as `VerifyQueueWidget`), `/priprava` (as `VerifikaceAdresCard`) | `/` (Home) — background process status belongs on the landing glance, not the launch-readiness checklist |
| Send-rate / active-campaigns live data | `/` (Home as `LiveClusterRateWidget`), `/analytics?tab=crony` (as `SendRateWidget + ActiveCampaignsLive`) | `/` (Home) — live throughput is a morning-glance metric; /crony is for static heartbeat diagnostics |
| `MissingPasswordBanner` is also implicitly covered by the step-1 card on `/priprava` (mailboxes step shows missing-password list) — three surfaces for one signal |

---

## Open questions for operator

1. **MailboxHealthBoard opt-in:** Is there any scenario where the health board provides value that the MailboxesTable health column does not? If not, DELETE is safe.

2. **TemplatePreviewWidget scope:** Should template preview be a first-class feature on `/templates` (inline per-template render), or is the `/priprava` collapsed preview an acceptable shortcut for a single-template workflow?

3. **Analytics timeline chart:** Is the 30-day send timeline used for any regular operator decision (e.g. checking whether weekend sends differ from weekday)? If yes, it should stay visible; if it's only used for retrospectives, collapsing it saves significant above-the-fold space.

4. **CSV export:** Is there a downstream tool (spreadsheet, reporting) that consumes the analytics CSV export? If not, the button should be deleted.

5. **Filter presets on /companies:** Are saved filter presets actively used for multiple targeting runs, or were they built speculatively? Usage data (if any) would inform whether to promote them or fold them away.

6. **L2 template metrics location:** Template performance data currently lives in both `/analytics/trendy` (aggregate view) and could live in `/templates` (per-template action view). Which view does the operator actually use to decide "this template is underperforming, let me rewrite it"?

7. **Campaigns StatusFilter chips visibility threshold:** Suggested threshold = 10 campaigns. Acceptable, or should chips always show?
