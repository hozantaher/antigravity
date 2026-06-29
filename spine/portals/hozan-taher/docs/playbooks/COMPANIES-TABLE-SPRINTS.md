# Companies Table — Sprints

Follow-on plan after `COMPANIES-UI-POLISH-SPRINTS.md` (page header stat strip, EnrichmentBar, drawer polish, empty states, toolbar consolidation).

This plan covers **table-specific improvements** to the Firmy table in `src/pages/Companies.jsx` — structure, scannability, one-row information density — mirroring the Mailboxes table sprints.

## Guiding principles

1. **Incremental wins over big-bang.** Prior Mailboxes modularization refactor was reverted for lost visual fidelity; keep `Companies.jsx` monolithic.
2. **Design checkpoints before code.** Any change touching column layout gets a before/after sketch in commit msg.
3. **Scannability > ornament.** Table should read top-to-bottom fast — no decorative elements that cost a glance.
4. **Reversible commits.** One commit per sprint on `wm/development`.

## Current state snapshot (2026-04-20)

**Columns** (lines 889–901 in `Companies.jsx`):

| # | Header     | Content                                                          | Width       |
|---|------------|------------------------------------------------------------------|-------------|
| 1 | Firma      | `name` bold + `ico · size` muted                                 | flex        |
| 2 | Kategorie  | `<CategoryBadge>` with click-to-filter (≤170px truncated)        | max 170px   |
| 3 | Město      | `address_locality` (muted, nowrap) or `—`                        | auto        |
| 4 | ICP        | `Ideální`/`Dobrá` colored text or `—`                            | auto        |
| 5 | E-mail     | `<EmailBadge>`: dot + address + confidence mini-bar (+ number)   | flex        |
| 6 | Kontakt    | `fmtDate(last_contacted)` or green "nový"                        | auto nowrap |
| 7 | Skóre      | `<TierBadge>` (A+/B/C + number) or `<ScoreBar>` fallback         | auto right  |
| 8 | (actions)  | `.row-hover-actions` mailto + tel + `ChevronRight` drawer cue    | 32px        |

**Sort:** `name`, `city`, `contacted`, `score` are sortable (`<SortTh>` helper); `Kategorie`, `ICP`, `E-mail` are not.

**Row hover:** `.row-hover-actions` surfaces mailto + tel icons on hover (already implemented, uses same pattern as Mailboxes).

**Empty states:** `<EmptyFilterState>` when no rows + not loading; 8 skeleton rows when loading.

**Load more:** "Načíst další (N)" button when `rows.length < total`.

Build green at post-pull state (`d7ac1db`). Exact bundle size to be captured before S1.

## Sprints

### S1 — Scannability polish (safe)

**Scope:** table headers + row hover rules in `src/index.css` (shared `table` / `.table-wrap` selectors) and the `<SortTh>` component in `src/pages/Companies.jsx` (lines 573–587).

**Today:** lowercase header labels ("Firma / Kategorie / Město …"), `ArrowUp / ArrowDown / ArrowUpDown` lucide icons, sort indicator always full-opacity for active sort but no color treatment on the header cell itself.

**Changes:**
- Header: UPPERCASE labels via CSS `text-transform: uppercase`, `letter-spacing: 0.02em`, `font-weight: 500`, `var(--muted)` default color; active-sort column gets `color: var(--text)` + bolder arrow.
- Row hover: `tbody tr:not(.co-row-selected):hover > td { background: var(--surface2); }`. Scope under `.co-table` (add className) to avoid leaking into other tables.
- Sort arrow: swap `<ArrowUp/Down>` / `<ArrowUpDown>` components for a single `ChevronDown` that rotates 180° via CSS transform when `dir==='asc'` (fewer icon renders, less visual flicker on toggle).
- Active sort column: apply `color: var(--text)` on the `<th>` itself, not just the indicator.

**Acceptance:**
- Rows highlight on hover without layout jump (no border-width toggling).
- Currently-sorted column visually obvious even when not hovering.
- No layout shift between default / hover / sorted states.
- Sort-click behavior unchanged (`handleSort` logic untouched).

**Estimated touch:** ~0 lines JSX, ~40 lines CSS.

**Revert:** `git checkout -- src/index.css src/pages/Companies.jsx`.

---

### S2 — Merge ICP dot into identity column

**Scope:** `<td>` for Firma (lines 905–910) and ICP column (lines 918–922) in `src/pages/Companies.jsx`, plus relevant CSS.

**Today:** ICP is its own column between E-mail/Město and shows colored text "Ideální" / "Dobrá" / `—`. Redundant whitespace when most rows are unscored.

**Changes:**
- Move a 6px color dot (`ICP_COLOR[c.icp_tier]`) as first inline child of Firma cell, before `name`:
  `<span className="co-icp-dot" style={{background: ICP_COLOR[icp_tier]}} aria-label="ICP: Ideální" title="ICP Ideální" />`
- Drop the separate `<th>ICP</th>` + `<td>` entirely.
- Keep ICP filter chip (`FilterChipRow` for `icpFilter`) — unaffected, it's a separate control above the table.
- For rows without `icp_tier`: render a muted hollow ring (1px border, no fill) to preserve alignment — avoids "jumpy" identity width.
- CSS: drop ICP column sizing, add `.co-identity` + `.co-icp-dot` rules, ensure the dot vertically centers with the `name` baseline.

**Acceptance:**
- ICP readable at the start of each row (dot + name on same line).
- Hover-tooltip announces ICP tier.
- No width regression in narrower viewports.
- Aria-label on the dot preserved (screen reader announces ICP before name).
- Sort-by-ICP **not** previously supported — no regression.
- Category-click-to-filter on the name row unaffected.

**Estimated touch:** ~20 lines JSX, ~30 lines CSS.

**Revert:** single-file checkouts.

---

### S3 — Score sparkline + delta

**Scope:** Skóre column `<td>` (lines 927–931) in `src/pages/Companies.jsx`, plus a new `<CompanyScoreSparkline>` helper (can reuse `src/components/Sparkline.jsx` if present).

**Today:** Skóre column renders either `<TierBadge tier={score_tier} score={composite_score}>` (when scored) or `<ScoreBar score={best_targeting_score}>` (fallback). No trend signal — scores are a single point-in-time read.

**Changes:**
- Add `score_trend_30d` prefetch: one `/api/companies/score-trends?days=30&icos=...` bulk request from Companies page on mount (batched via IDs of currently loaded rows), store in `scoreTrends[ico]` map.
- Backend contract: array of up to 30 ints per IČO (weekly or daily composite-score snapshots). If endpoint missing → render score column as today (graceful fallback, zero visual noise).
- Inline sparkline: 56×14px, placed **left of** the TierBadge / ScoreBar, same `--accent` tone, `opacity: 0.6` when no trend available.
- Delta pill: when `trend[trend.length-1] - trend[0] != 0`, show `▲+12` green or `▼−4` red in `var(--text-xs)` next to the tier letter. Hide when absolute delta < 3 (reduce noise).
- Compact density (if a density toggle is added in S4): sparkline only, hide tier letter + number.

**Acceptance:**
- Sparkline renders for companies with ≥2 data points; missing data → no sparkline, no "—".
- API failure → layout identical to today, no error toast, no console warning.
- Bulk request caps at 200 IČOs per call (split into batches if needed).
- Score column still sortable.
- No per-row fetches under any circumstance.

**Dependencies:** backend needs `/api/companies/score-trends`. If not present, fallback: compute dashboard-side delta from `scored_at` history via existing `/api/companies/:ico/verification-history`-style endpoint if extended for scores — or ship the sparkline as a no-op placeholder behind a `showSparkline` feature flag.

**Estimated touch:** ~50 lines JSX, ~30 lines CSS, ~25 lines for a new `<CompanyScoreSparkline>` or reuse of `src/components/Sparkline.jsx`.

**Revert:** single-file checkouts; backend endpoint work stays behind.

---

### S4 — Column hygiene & conditional visibility

**Scope:** column header render in `src/pages/Companies.jsx` lines 889–901, row cells in 903–949, plus a new `useColumnVisibility` helper (or inline `useMemo`).

**Today:** all 7 data columns + action column always render, even when every row has `email=null` (catch-all empty cells), no `address_locality`, or no `icp_tier` (after S2, ICP moves inline so this concern shifts to Město / E-mail / Kontakt).

**Changes:**
- `showCity    = rows.some(r => r.address_locality)` — hide Město column when the entire loaded page has no city data.
- `showEmail   = rows.some(r => r.email)` — hide E-mail column when no row has an email (already conditional for bulk-verify button; make column follow).
- `showContact = rows.some(r => r.last_contacted)` — hide Kontakt column when nothing has been contacted (shows all "nový" — redundant).
- `showScore   = rows.some(r => r.composite_score != null || r.best_targeting_score != null)` — extremely rare edge case; probably always true, but protect against empty-DB render.
- Add a header "columns" dropdown (`<ColumnsMenu>`) — lets user toggle `Kategorie`, `Město`, `ICP dot`, `E-mail`, `Kontakt`, `Skóre` manually. Preference persisted in `localStorage('co.cols')`.
- Replace all `—` cell content with blank (empty string) — modern tables convention; empty cell is a valid signal.
- Preserve `colSpan={visibleCount}` on the empty-state row.

**Acceptance:**
- No column header visible for a column where every row is empty.
- User can manually force-hide a column and it persists across reload.
- Re-showing columns restores canonical order (no sticky rearrangement).
- Skeleton rows adapt to visible column count (no off-by-one).
- Empty state `<tr><td colSpan={N}>` uses dynamic `N`.

**Estimated touch:** ~60 lines JSX, ~25 lines CSS.

**Revert:** single-file checkout.

---

### S5 — Keyboard navigation in the table

**Scope:** `<tr>` `onKeyDown` + row `tabIndex` in `src/pages/Companies.jsx` lines 903–949, plus a new page-level handler for row focus.

**Today:** rows have `onClick={() => setSelected(c.ico)}` but no keyboard affordance. `<tr>` is not focusable. Only the top-level `useKeyboardShortcuts` bindings (`/`, `?`, `c`, `x`, `Esc`) work.

**Changes:**
- Add `tabIndex={0}` + `role="button"` + `aria-label="Otevřít detail firmy: <name>"` to each `<tr>`.
- `↑/↓`: focus prev/next row (when focus is inside `.co-table tbody` and no drawer open). Use existing focus ring; don't create a new one.
- `Home/End`: focus first/last row.
- `Enter`: opens drawer for focused row.
- `Space`: reserved for **row selection** (future multi-select / bulk-verify surface) — in this sprint just preventDefault so it does not scroll the page.
- `j/k`: vim-style aliases for `↓/↑` (Mailboxes parity, optional).
- Page-level handler: if focus is already in `.co-table tbody` and user presses `Esc`, clear row focus (return focus to search).

**Implementation note:** use `useRef` for the `tbody` element, delegate the keydown there. Don't re-bind on every row render.

**Acceptance:**
- Arrow navigation doesn't leak to window scroll (preventDefault when row is focused).
- Space does not open drawer (reserved), Enter does.
- Screen reader announces row identity on focus (preserve `aria-label`).
- No regression on category-click-to-filter inside the Kategorie cell (event.stopPropagation still needed).
- `ShortcutsHelp` lists the new bindings under a "Tabulka" group.

**Estimated touch:** ~50 lines JSX, ~10 lines CSS.

**Revert:** single-file checkout.

---

## Cross-sprint checklist

Before each sprint commit:
- [ ] `pnpm build` green
- [ ] `pnpm test -- Companies` green (drawer + filters tests)
- [ ] Manually: sort by each sortable column, apply + clear every filter, open drawer via click + via Enter (after S5), hover actions work, bulk-verify still triggers.
- [ ] Keyboard: `/` focus search still works, `c` opens category panel, `?` opens help.
- [ ] No console errors/warnings.
- [ ] Commit on `wm/development` with `type(scope): short (Sx)` message, e.g. `feat(ui): companies score sparkline (S3)`.

## Out of scope

- Column drag-to-reorder — too much UX surface for marginal win.
- Inline row editing — explicit non-goal; editing stays in drawer/modal.
- Virtualization — current max is LIMIT=50 rows per page; virtualize only if user reports scroll lag on very large result sets.
- Dashboard / Mailboxes / Campaigns / Analytics tables — separate plans.
- Backend changes beyond S3's optional `/api/companies/score-trends` endpoint.
- Row selection UI (checkboxes + bulk actions bar) — explicitly reserved for a follow-up plan after S5 lands.

## Session references

- Prior sprint plan: `docs/playbooks/COMPANIES-UI-POLISH-SPRINTS.md` (S1–S6).
- Templates borrowed from: `docs/playbooks/MAILBOXES-TABLE-SPRINTS.md`.
- Main source: `features/platform/outreach-dashboard/src/pages/Companies.jsx` (monolithic, 984 lines).
- Revert base: commit `d7ac1db` on `wm/development`.
