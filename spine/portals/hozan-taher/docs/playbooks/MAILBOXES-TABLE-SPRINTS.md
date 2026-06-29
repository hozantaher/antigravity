# Mailboxes Table — Sprints

Follow-on plan after the 2026-04-20 Mailboxes polish series (filter toolbar redesign, stat strip, AnonymizationBar split, drawer badge, empty states, keyboard shortcuts, compact density).

This plan covers **table-specific improvements** to `.mb-table` in `src/pages/Mailboxes.jsx` — structure, scannability, and one-row information density.

## Guiding principles

1. **Incremental wins over big-bang.** Prior modularization refactor was reverted for lost visual fidelity; keep `Mailboxes.jsx` monolithic.
2. **Design checkpoints before code.** Any change touching column layout gets a before/after sketch in commit msg.
3. **Scannability > ornament.** Table should read top-to-bottom fast — no decorative elements that cost a glance.
4. **Reversible commits.** One commit per sprint on `wm/new-features`.

## Current state snapshot (2026-04-20)

Columns: `check (32px) | identity | status (32px) | health (82px) | delivery (150px) | [warmup (152px, conditional)] | activity (128px)`.

- Identity: `email · display_name` + `proxy-dot host:port` (hidden in compact).
- Status: bare color dot with `title=reason`, aria-labeled.
- Health: 82px numeric pill (score or refresh icon), click to re-check.
- Delivery: `sent · bounce%` + `daily_limit/den · cb× v řadě` (hidden in compact).
- Warmup: "Den X/30" + progress bar; column auto-hides when nobody is warming.
- Activity: `fmtDate(last_send_at)` or "Nikdy"; hover reveals pause/edit actions.

Build green at `73.47 kB` CSS / `518.31 kB` JS.

## Sprints

### S1 — Scannability polish (safe)

**Scope:** `.mb-table` headers + rows in `src/index.css`.

**Today:** uppercase header labels (`SCHRÁNKA / STAV / ZDRAVÍ …`), sort indicator opacity 0.5 on hover, no row-hover tint.

**Changes:**
- Header: lowercase weight 500, letter-spacing tightened, active-sort column gets `color: var(--text)` + bolder arrow.
- Row hover: `tbody tr:not(.mb-row-open):not(.mb-row-selected):hover > td { background: var(--surface2); }`.
- Sort arrow: swap `<ArrowUp/Down>` component for a single chevron that rotates 180° via CSS transform when `dir==='desc'` (fewer icon renders).
- Active sort column: subtle `color: var(--text)` on the header cell itself (not just indicator).

**Acceptance:**
- Rows clearly highlight on hover without jumping.
- Currently-sorted column is visually obvious even when not hovering it.
- No layout shift between default / hover / sorted states.

**Estimated touch:** ~0 lines JSX, ~30 lines CSS.

**Revert:** `git checkout -- src/index.css`.

---

### S2 — Merge status dot into identity

**Scope:** `<td className="mb-cell-identity">` and `<td className="mb-cell-status">` in `src/pages/Mailboxes.jsx` (lines ~1606–1626), plus `.mb-col-status` CSS.

**Today:** status is its own 32px column between identity and health.

**Changes:**
- Move `<span className="list-status-dot">` inline as first child of `.mb-identity-line`, before email.
- Remove the `<th className="mb-col-status">` + `<td className="mb-cell-status">` entirely.
- Keep status filter dropdown (unaffected — it's a separate control).
- Sort-by-status stays available via the same dropdown.
- CSS: drop `.mb-col-status`, `.mb-cell-status`. Adjust `.mb-identity-email` to align-center with the new leading dot.

**Acceptance:**
- Status readable at the start of each row (dot + email on same line).
- No width regression in narrower viewports.
- Aria-label on the dot preserved (screen reader announces status before email).
- Sort-by-status dropdown still affects ordering.

**Estimated touch:** ~15 lines JSX, ~20 lines CSS.

**Revert:** single-file checkouts.

---

### S3 — Delivery sparkline

**Scope:** `<td className="mb-cell-delivery r">` in `src/pages/Mailboxes.jsx` (lines ~1639–1656), plus a new `<MailboxSparkline>` helper.

**Today:** `sent · bounce%` main line + `limit · cb× v řadě` sub-line (sub-line hidden in compact).

**Changes:**
- Add `send_trend_7d` prefetch: one `/api/mailboxes/send-trends?days=7` call from Mailboxes page on mount (bulk), store in `sendTrends[mbId]` map.
- Backend contract: array of 7 ints per mailbox (day-by-day send count). If endpoint missing → render delivery as today (graceful fallback).
- Inline sparkline: 48×14px, left of `sent` number, same tone as `.mb-delivery-rate`.
- Bounce %: replace `· 1.2%` text with a `tone-warn/err` colored pill if `> 2%`, hide otherwise (reduce noise for clean mailboxes).
- Compact density: sparkline only, hide all text except `sent`.

**Acceptance:**
- Sparkline renders for mailboxes with ≥1 day of data; missing data → no sparkline, no "—".
- API failure → layout identical to today, no error toast.
- Compact row height unchanged.
- No per-row fetches; single bulk request.

**Dependencies:** Go backend needs `/api/mailboxes/send-trends` or equivalent. If not present, implement dashboard-side fallback via existing `/api/analytics/timeline` aggregated per mailbox.

**Estimated touch:** ~40 lines JSX, ~30 lines CSS, ~20 lines for `<Sparkline>` reuse from `src/components/Sparkline.jsx`.

**Revert:** single-file checkouts; endpoint work stays behind.

---

### S4 — Column hygiene & conditional visibility

**Scope:** column visibility helpers + header render in `src/pages/Mailboxes.jsx` (lines ~1538–1547).

**Today:** warmup column auto-hides when no rows are warming. Everything else always renders.

**Changes:**
- `showProxyCol = mailboxes.some(m => m.proxy_url)` — if nobody has proxy, drop proxy-dot from identity meta (reclaim width on narrow viewports).
- `showHealthCol = Object.values(liveScores).some(ls => ls.score != null)` — if health endpoint failed entirely, hide the column instead of showing empty pills.
- Add a header "columns" dropdown: lets user toggle `delivery bounce %`, `warmup`, `activity` manually. Preference persisted in `localStorage('mb.cols')`.
- Replace all `—` cell content with blank (empty string) — modern tables convention.

**Acceptance:**
- No column header visible for a column where every row is empty.
- User can manually force-hide a column and it persists across reload.
- Re-showing columns restores order (no sticky rearrangement).

**Estimated touch:** ~50 lines JSX, ~20 lines CSS.

**Revert:** single-file checkout.

---

### S5 — Keyboard navigation in the table

**Scope:** `<tr>` onKeyDown in `src/pages/Mailboxes.jsx` (lines ~1587–1592), plus new page-level handler.

**Today:** only Enter/Space open drawer; no way to navigate between rows without mouse.

**Changes:**
- `↑/↓` focuses prev/next row (when focus is inside `.mb-table tbody` and no drawer open).
- `Home/End` focuses first/last row.
- `Enter` opens drawer for focused row (already works).
- `Space` toggles selection checkbox for focused row (currently opens drawer — reassign).
- `x` or `Shift+click` for range-select (stretch).
- Focus ring: use existing `.table-wrap tr:focus-visible` rule.

**Acceptance:**
- Arrow navigation doesn't leak to window scroll.
- Space no longer opens drawer — only Enter does.
- Selection checkbox toggle via Space works in all rows.
- Screen reader announces row email on focus (preserve `aria-label` chain).

**Estimated touch:** ~40 lines JSX, ~5 lines CSS.

**Revert:** single-file checkout.

---

## Cross-sprint checklist

Before each sprint commit:
- [ ] `pnpm build` green
- [ ] Manually: sort by each column, filter by status + health, open drawer, hover actions work
- [ ] Keyboard: `/` focus search still works, `n` opens modal, row interactions per sprint
- [ ] No console errors/warnings
- [ ] Commit on `wm/new-features` with `type(scope): short (Sx)` message

## Out of scope

- Column drag-to-reorder — too much UX surface for marginal win.
- Inline row editing — explicit non-goal; editing stays in drawer/modal.
- Virtualization — current max is ~50 rows; virtualize only if user reports scroll lag.
- Dashboard/Campaigns/Analytics tables — separate plans.
- Backend changes beyond S3's optional endpoint.

## Session references

- Prior sprint plan: `docs/playbooks/MAILBOXES-UI-POLISH-SPRINTS.md` (S1–S5 done).
- Main source: `features/platform/outreach-dashboard/src/pages/Mailboxes.jsx` (monolithic, ~1720 lines).
- Revert base: commit `419ec0c` on `wm/new-features`.
