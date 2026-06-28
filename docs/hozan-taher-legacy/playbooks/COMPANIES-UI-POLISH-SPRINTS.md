# Companies UI Polish — Sprints

Follow-on plan mirroring the 2026-04-20 Mailboxes polish series (stat strip, unified toolbar, drawer, empty states, keyboard) — now applied to **Firmy** (`src/pages/Companies.jsx`, 984 lines).

This plan covers the **page-level rough edges** on the Companies page. A sister plan — `COMPANIES-TABLE-SPRINTS.md` — covers `<table>`-specific improvements (scannability, column hygiene, sparkline, keyboard nav).

## Guiding principles (session learnings, reused)

1. **Incremental wins over big-bang.** The Mailboxes modularization refactor was fully reverted. Keep `Companies.jsx` monolithic.
2. **Design checkpoints before code.** For layout/hierarchy changes, propose 2–3 directions first, ship after user confirms.
3. **Labels beat icons.** Every visual cue pairs with text, or has dominant-color + hover tooltip.
4. **Remove clutter, don't add.** Zero-count chips, redundant rows, text-heavy dividers → out. Density is the enemy.
5. **Reversible commits.** One commit per sprint on `wm/development` so revert cost is low.

## Current state snapshot (2026-04-20)

`src/pages/Companies.jsx` top-to-bottom:

- **Page head** (lines 747–757): `h2` "Firmy" + muted subtitle `<total> odpovídá filtru` / `<totalCompanies> celkem`. No stats beyond the count.
- **Filter toolbar** (lines 760–885): **5 separate rows** of filter controls —
  - Row 1: `SearchInput` + "Hledat" btn + "Kategorie (N)" btn + "Zrušit vše".
  - Row 2: `PresetDropdown` (standalone).
  - Row 3: active category chips (`CategoryActiveChip`) — conditional.
  - Row 4: `FilterChipRow` ICP + Velikost + `ScoreRangeSlider` + `RegionSelect` + `SectorSelect` + "Nikdy nekontaktováno" checkbox.
  - Row 5: `FilterChipRow` Engagement + `DatePresetFilter` + `EmailConfidenceFilter` + `HasWebsiteFilter`.
  - Row 6: `FilterChipRow` Email + "Ověřit filtrované (N)" bulk button.
- **Category modal** (lines 797–827): full-screen overlay with `CategoryFilter` tree, "Vymazat vše" / "Použít" footer.
- **Table wrap** (lines 888–971): covered in `COMPANIES-TABLE-SPRINTS.md`.
- **Load more button** (lines 973–978).
- **`CompanyDrawer`** (lines 153–569): four sections — warnings strip, 4-KPI grid, contact block (email/phone/web/address), composite score + `ScoreBreakdown`, category + enrichment details, description, campaigns. Uses verify + recompute-score + verification-history endpoints.
- **`ShortcutsHelp`** dialog (mounted unconditionally).

Keyboard bindings in place: `/` focus search, `?` help overlay, `c` toggle category panel, `x` clear filters, `Esc` closes panel/help/search.

## Sprints

### S1 — Page header stat strip

**Scope:** `.page-head` in `src/pages/Companies.jsx` lines 747–757.

**Today:** one muted subtitle next to the `h2` (`<N> odpovídá filtru`). No breakdown.

**Options to propose:**
- A) 4 KPI tiles: `Celkem ve filtraci` · `Ideální ICP (%)` · `Ověřené e-maily (%)` · `Nikdy nekontaktované (N)`. Equal width, subtle border, tabular numbers.
- B) Horizontal stat strip with dot-prefixed items + separators: `● 1 234 firem · ● 312 ideal · ● 48% verified · ● 890 nikdy`.
- C) Keep single subtitle, but lead with dominant count and right-align a secondary `Průměr skóre: 64 · Medián: 58` pill.

**Acceptance:**
- Reads at a glance (primary stat — total-in-filter — dominant).
- Adapts to 2–4 stats when facets are absent (e.g., no ICP scored yet → hide that tile).
- Does not push the filter toolbar below-the-fold on 1440p.
- Uses `.drawer-metric` tokens for visual parity with the Mailboxes stat strip.

**Estimated touch:** ~40 lines JSX, ~50 lines CSS.

**Revert:** `git checkout -- src/pages/Companies.jsx src/index.css`.

---

### S2 — EnrichmentBar (analog to AnonymizationBar)

**Scope:** new component inserted between `.page-head` and filter toolbar (around line 759), drawing from existing backend facets + enrichment freshness.

**Today:** there is **no infrastructure bar** on Companies. Data quality (email-verified %, enrichment age, ARES freshness, score coverage) is entirely invisible from this page.

**Options to propose:**
- A) Two pills + optional alert: `[✓ 84% ověřeno]  [✓ Enrichment 2d]  [⚠ 128 firem bez e-mailu]`. Alert only when non-trivial gap.
- B) Single strip with dot-coded sub-metrics: `[● E-mail 84% · Web 61% · Telefon 43% · Enrichment 2d]  [↻]`.
- C) Collapsed "Data quality: OK" pill that expands a popover with full breakdown on click.

**Data sources:**
- Existing `facets` from `useFacets()` hook (already in page).
- Possible new endpoint `/api/companies/data-quality` (dashboard-side aggregation acceptable fallback — compute from `rows` or a single `/api/companies?limit=1&facets=true` pull).
- Enrichment age: `max(updated_at)` or `min(enrichment_staleness)` from Go `/metrics/enrichment`.

**Acceptance:**
- Alert state (`unverified > threshold` or `enrichment > 7d`) visually distinct from steady-state info.
- Refresh button triggers facets reload + small spinner; no layout shift.
- Bar hides entirely when all metrics are null (no facets loaded yet) — no empty placeholder.
- Respects reduced-motion (no pulse on the refresh icon).

**Estimated touch:** ~60 lines JSX, ~70 lines CSS, optional ~20 lines backend aggregator.

**Revert:** single-file checkouts; backend endpoint work stays behind.

---

### S3 — Drawer polish

**Scope:** `CompanyDrawer` in `src/pages/Companies.jsx` lines 153–569. Intentionally big — audit rather than restructure.

**Today:** sections flow linearly —
1. Head (name + IČO + close)
2. Warning strips (zaniklá / likvidace / insolvence) — conditional
3. 4-KPI grid (Skóre / ICP / Odesláno / Odpovědi)
4. Contact block (email + verify button + status pill + SPF/DMARC/free-webmail badges + verification-history collapsible)
5. Composite score + `ScoreBreakdown` + recompute button
6. Category + sector + enrichment fields (`Row` helper)
7. Description (clamped at 300 chars)
8. Campaigns list

**Candidates for polish (pick before starting):**
- **Section headings:** add muted labels `Kontakt` / `Skóre` / `Firmografie` / `Historie` so the reader can scan; today sections run together.
- **Tab split:** optional — `Overview` / `Skóre` / `Enrichment` / `Kampaně` tabs, same pattern as `MailboxDrawer`. Only if user agrees; otherwise keep linear.
- **Verify / Recompute buttons:** align styling (both use `btn-ghost btn-sm` but different icon sizes + padding — normalize).
- **Description ellipsis:** replace `slice(0, 300) + '…'` with CSS `-webkit-line-clamp: 4` + "Zobrazit vše" toggle.
- **Campaigns empty:** when `data.campaigns` is empty, show a muted "Žádné kampaně" line instead of hiding the section entirely (discoverability).
- **Footer action bar:** sticky-bottom with primary actions (Ověřit / Přepočítat skóre / Otevřít detail kampaně). Today actions are scattered; consolidate.

**Explicit non-goals:**
- Do not modularize into `src/components/companies/Drawer/**`. Last attempt on Mailboxes was reverted.
- Do not change the verify / recompute-score / verification-history endpoint contracts.
- Do not add keyboard shortcuts to the drawer in this sprint (reserve for S5).

**Acceptance:**
- All existing sections still render without layout shift.
- Buttons share consistent padding/icon-size/disabled state.
- No visual regression vs current state unless explicitly approved per change.
- `Companies.drawer.test.jsx` stays green.

**Estimated touch:** ~60 lines JSX, ~80 lines CSS.

**Revert:** single-file checkout.

---

### S4 — Modals + empty states

**Scope:**
- Category filter modal (lines 797–827).
- Empty states — `rows.length === 0 && !loading` path (lines 960–968, uses `EmptyFilterState`).
- Load-more button (lines 973–978) — subtle polish.
- `ShortcutsHelp` dialog — audit copy parity with Mailboxes.

**Today:**
- Category modal uses generic `.modal` class; header/footer padding inconsistent with Mailboxes modals.
- `EmptyFilterState` already handles one generic "žádné výsledky" case. Does **not** distinguish between:
  - (a) first-time user, zero companies in DB → "Spusť scraper nebo naimportuj ARES";
  - (b) filters exclude everything → show active filter list + "Zrušit filtry";
  - (c) search term with no results → suggest "Vyčistit vyhledávání".

**Options to propose for empty states:**
- A) Keep `EmptyFilterState`, extend its props with a `variant` (`'empty-db'` | `'no-filter-match'` | `'no-search-match'`).
- B) Separate component per variant — clearer but more surface.
- C) Keep current variant, improve copy only (lowest risk, smallest win).

**Modals:**
- Audit category-modal header padding + close-button alignment against the Mailboxes MailboxModal / CsvImportModal.
- Ensure footer layout matches (`Vymazat vše` secondary + `Použít` primary + aria-live count on the left).

**Acceptance:**
- Two clearly distinct empty states (cold-start vs filter-empty).
- Modal padding / typography matches Mailboxes visual rhythm.
- `Companies.filters.test.jsx` stays green.

**Estimated touch:** ~40 lines JSX, ~30 lines CSS.

**Revert:** single-file checkout.

---

### S5 — Filter toolbar consolidation

**Scope:** filter rows in `src/pages/Companies.jsx` lines 760–885. **Five rows** of filters is the single most visible polish gap on this page.

**Today:** filter controls span 5–6 flex rows, stacked vertically, each with its own gap/margin. Category chips + PresetDropdown sit on their own rows. On 1366px laptop viewports the table starts ~280px below the page head.

**Options to propose:**
- A) **Primary-row + secondary-row pattern (Mailboxes convention):**
  - Primary: `[🔍 search] [Hledat] [Kategorie (N)] [Presets ▼] [Zrušit vše]`
  - Secondary (always visible): `[ICP ▾] [Velikost ▾] [Skóre ⤢] [Region ▾] [Sektor ▾] [E-mail ▾] [Engagement ▾] [… další ▾]` with overflow spilling into a "Další filtry" dropdown when width < 1200px.
  - Active filter chips (including category-chips) flow inline on a thin third row, only when `hasActive`.
- B) **Left rail + inline chips:** collapse all filters into a left `<aside>` drawer (toggled by "Filtry (N)" button), keep only search + active chips on the page. Bigger refactor.
- C) **Status-quo plus tightening:** keep 5 rows but remove gaps/margins between them, switch labels to inline (no "ICP:" prefix), shrink to 4 rows.

**Recommended:** **A** — matches Mailboxes muscle memory, highest scan-density win.

**Responsive behavior:**
- ≥1440px: all filters inline in one secondary row.
- 1024–1440px: 2nd secondary row accepts overflow.
- <1024px: collapse into `Filtry (N) ▾` button that opens the filter set in a popover.

**Acceptance:**
- Page head + filter toolbar combined ≤ 160px tall on 1440p (currently ~280px).
- All existing filters still reachable; none removed.
- Presets and active-chip rows still serialize filters round-trip (URL + `useCompanyFilters`).
- Facet counts still render next to each option.
- `Companies.filters.test.jsx` stays green.

**Estimated touch:** ~150 lines JSX, ~120 lines CSS.

**Revert:** single-file checkout on `Companies.jsx` + `src/index.css`.

---

### S6 (stretch) — Keyboard + responsive

**Scope:** page-level keyboard shortcuts (already wired via `useKeyboardShortcuts`) + mobile layout.

**Today:** `/`, `?`, `c`, `x`, `Esc` bound. No `n` (new company / import), no `j/k` row navigation (covered separately in `COMPANIES-TABLE-SPRINTS.md` S5), no mobile-tailored layout.

**Candidates:**
- `n` opens CSV import or "Add company" modal (if one exists on Companies; otherwise focus CSV-upload flow).
- `e` triggers `bulkVerify()` from page context (analog to `Ověřit filtrované`).
- Mobile breakpoint (<768px): stacked filter chips with `flex-wrap: wrap` already partially works; consider hiding city/ICP columns and surfacing them in the drawer only.

**Explicit non-goals:**
- No React Router changes.
- No mobile-first rewrite.
- No change to existing bindings.

**Acceptance:**
- New shortcuts don't fire while user is typing in any input/textarea/select.
- Shortcuts discoverable via `ShortcutsHelp` (extend the list).
- No regression on focus traps around category modal / drawer.

**Estimated touch:** ~30 lines JSX, ~80 lines CSS.

---

## Cross-sprint checklist

Before each sprint commit:
- [ ] `pnpm build` green
- [ ] `pnpm test -- Companies` green (filters + drawer tests)
- [ ] Manually: open Companies page, verify drawer opens/closes, all filters apply, category modal opens/closes, `ShortcutsHelp` opens on `?`.
- [ ] Confirm no console errors/warnings introduced.
- [ ] `git diff --stat` sanity-check (no accidental file deletions).
- [ ] Commit on `wm/development` with `type(scope): short (Sx)` message, e.g. `feat(ui): companies stat strip (S1)`.

## Out of scope

- Dashboard / Mailboxes / Campaigns / Analytics pages — separate plans.
- Backend / BFF / Go service contracts beyond S2's optional aggregator endpoint.
- i18n — Companies is Czech-only.
- New filter semantics — this plan polishes rendering, not the `useCompanyFilters` query model.

## Session references

- Sister plan: `docs/playbooks/COMPANIES-TABLE-SPRINTS.md` (table-specific sprints).
- Templates borrowed from: `docs/playbooks/MAILBOXES-UI-POLISH-SPRINTS.md` + `docs/playbooks/MAILBOXES-TABLE-SPRINTS.md`.
- Main source of truth: `features/platform/outreach-dashboard/src/pages/Companies.jsx` (monolithic, ~984 lines, intentionally kept that way).
- Revert base: commit `d7ac1db` on `wm/development`.
