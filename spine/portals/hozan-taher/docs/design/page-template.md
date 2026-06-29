# Page template — UX baseline

`/mailboxes` is the design reference. Every list page in the dashboard
follows the same skeleton so the operator does not have to relearn UI
between routes.

## Structure (top-down)

```
┌──────────────────────────────────────────────────────────────────┐
│ <PageHead>                                                        │
│   ┌─stats slot (left, flex:1)──────┐  ┌─actions slot (right)──┐ │
│   │ <PageStatStrip>                 │  │ <button> Import       │ │
│   │   <PageStat tone num label />   │  │ <button primary>+Add  │ │
│   │   <PageStat ... />              │  │                       │ │
│   └─────────────────────────────────┘  └───────────────────────┘ │
├──────────────────────────────────────────────────────────────────┤
│ <PageToolbar>                                                     │
│   <SearchInput />  <select.page-filter-select>  <ChipGroup>...   │
│   {hasFilters && <FilterCount … />}     <PageToolbarSpacer/>     │
│   <RefreshButton />  <DensityToggle />                           │
├──────────────────────────────────────────────────────────────────┤
│ <table> primary list … rows open <Drawer> via ?id=&tab= URL     │
└──────────────────────────────────────────────────────────────────┘
```

## Components (`src/components/page/`)

| Component | Slot | Notes |
|---|---|---|
| `<PageHead stats actions>` | top header row | `actions` is optional; `stats` falls back to `children` |
| `<PageStatStrip>` | left of head | wraps children, auto-injects `.page-stat-sep` between siblings; pass `withSeparators={false}` to opt out |
| `<PageStat tone num label title>` | inside strip | tone: `'ok' \| 'warn' \| 'err'` (renders colored leading dot) — omit for label-only entries |
| `<PageToolbar>` | row above table | flex-wrap row for search + filters |
| `<PageToolbarSpacer>` | inside toolbar | pushes trailing controls to the right |
| `<FilterCount filtered total onReset?>` | inside toolbar | pill counter, shows `"X z Y"` when filtered, with optional reset button |
| `<ChipGroup label>` | inside toolbar | `role="group"` wrapper for chip filters |
| `<Chip tone active count onClick>` | inside ChipGroup | toggle filter, leading dot when tone set |

## CSS scope (canonical, in `src/index.css`)

- `.page-stat-strip`, `.page-stat`, `.page-stat-dot`, `.page-stat-num`, `.page-stat-label`, `.page-stat-sep`, `.page-stat-heartbeat`
- `.page-toolbar`, `.page-toolbar-spacer`
- `.page-filter-count`, `.page-filter-select`
- `.page-chip-group`, `.page-chip`, `.page-chip-dot`, `.page-chip-count`
- `.page-head`, `.page-head-actions` (already pre-existing)

Page-specific class prefixes (`.mb-*`, `.co-*`, `.cm-*`) are reserved
for **truly page-specific** UI: status row tinting, density variants,
custom row decorations. Anything that's the same across two pages goes
to `.page-*`.

## When NOT to use the primitives

- One-off metric tile (e.g. inside a drawer panel) — use
  `<DrawerMetric>` from `src/components/drawer/`.
- Custom hero / dashboard widget — `.page-stat-*` is for the strip
  shape; freeform layouts can live in their own component.
- Detail pages without a list (`/campaigns/:id` until F2b lands) — use
  the existing card stack until the redesign cuts that layer.

## Drawer pattern (already canonical)

URL-driven open/close:
- list page reads `?<entity>=<id>&tab=<tab>` from `useSearchParams`
- row click `setParams({ <entity>: id })`
- drawer has its own tab list (1/2/3 keyboard, `j`/`k` between siblings)
- `<DrawerSection>`, `<DrawerPanel>`, `<DrawerMetric(Grid)>`,
  `<DrawerList>` already shipped under `src/components/drawer/`

## Stats strip rules of thumb

- 4–6 numbers max — if you need 7, the page is probably trying to be a
  dashboard. Move the surplus into a drawer or a separate sub-page.
- Tone dots only when the number has a status meaning (`ok` = healthy,
  `warn` = needs attention, `err` = broken). Plain counts get no dot.
- `num` accepts a string (`fmtNum(...)`) or a number — the component
  renders it verbatim. Pre-format outside the component.
- The first stat is usually the "primary count" (active campaigns,
  unhandled replies, total companies …). Subsequent stats add color.

## Toolbar rules of thumb

- Search field comes first and gets `flex: 1`.
- One `<select>` for the dominant categorical filter (status/state).
  Anything more belongs in chip filters or in a side panel.
- Chip filters are *toggles*, not radio buttons — clicking the active
  chip clears it.
- Render the chip only when its count > 0. Empty filter chips are
  noise.
- `<FilterCount>` and the reset button appear *only* when filters are
  active. They do not occupy space at rest.
- After `<PageToolbarSpacer />` go meta controls: refresh, density,
  column-visibility menu.

## Slide-over drawer audit (Sprint C4)

The dashboard ships **two slide-over patterns**. The audit
(`tests/audit/drawer-overlay.test.js`) locks the canonical one:

1. **Canonical** — `.drawer-bg` (or `.drawer-overlay` alias) +
   `.drawer` panel. Used by `/mailboxes`, `/contacts`, `/segments`.
   Width 520px (max 100vw on mobile). Click overlay → close.
   Drawer has `position: fixed; right: 0; top: 0; bottom: 0` and
   slides in from the right via the `drawer-in` keyframe animation.
2. **Bespoke** — inline `style={{ position: 'fixed', inset: 0 }}` +
   inline drawer panel. Used by `/replies` (302px) and `/inbox`
   (also inline). These are narrower because the content is tighter
   (single reply, not a full mailbox config).

The bespoke implementations should eventually consolidate onto the
canonical class, but the width difference is real (302 px feels right
for a one-reply panel, 520 px feels right for a multi-tab mailbox
detail). A `<SlideOverDrawer width="narrow"|"wide" />` primitive could
host both — left for a follow-up.

### Anti-pattern landed and fixed (C4)

`/contacts` and `/segments` were rendering `<div class="drawer-overlay">`
but the CSS only had a rule for `.drawer-bg`. The backdrop was
invisible — the click-to-close target worked, but the page bled
through the unstyled overlay div. Fixed in C4 by adding
`.drawer-overlay` as a co-selector on the same rule:

```css
.drawer-bg,
.drawer-overlay { … same rule … }
```

The audit test guards against the regression.
