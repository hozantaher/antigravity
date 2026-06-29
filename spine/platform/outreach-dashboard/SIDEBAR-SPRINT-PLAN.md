# Sidebar Sprint Plan

Baseline: 3 sections (Pracovní prostor / Přehledy / Konfigurace), HR dividers, "Nová kampaň" CTA, footer with status dot + theme toggle. Studio palette, #3B4CCA accent, #F6F8FB bg, Inter, density-tight.

---

## Sprint 1 – Interaktivita

**Goal:** Collapsible sections and keyboard shortcut hints.

**Tasks:**
- [x] Collapsible `Přehledy` and `Konfigurace`: chevron toggle, open by default, persist state to `localStorage` — `Layout.jsx`
- [x] Kbd hints on `WORKSPACE_NAV` item hover: `⌘1–⌘4`, `opacity 0→1`, `IS_MAC` aware (shows `Ctrl` on non-Mac) — `Layout.jsx`, `index.css`

**Acceptance criteria:**
- [x] Sections collapse/expand with chevron; state survives page reload
- [x] Shortcut badges fade in on nav item hover, correct modifier per platform
- [x] No layout shift when toggling sections

---

## Sprint 2 – Vizuální lesk

**Goal:** Polish active states, CTA, logo, section labels, and nav hover.

**Tasks:**
- [x] Active nav item: add subtle `accent-soft` background gradient behind existing left-border accent — `index.css`
- [x] CTA "Nová kampaň": gradient shimmer sweep on hover + stronger `box-shadow` — `index.css`
- [x] Logo: replace `InboxIcon` with CSS-only `HT` monogram (rounded square, accent bg, white text) — `Layout.jsx`, `index.css`
- [x] Section labels: `text-transform: uppercase`, increased `letter-spacing`, slightly larger `font-size` — `index.css`
- [x] Nav item hover: slide-in background from left via `clip-path` animation — `index.css`

**Acceptance criteria:**
- Active item visually distinct (border + gradient) at all breakpoints
- CTA shimmer runs once per hover entry, no jank
- `HT` monogram renders without external assets

---

## Sprint 3 – Živý footer

**Goal:** Live micro-stats and health-aware status dot.

**Tasks:**
- Footer second line: active campaign count + unhandled reply count pulled from existing stores — `Layout.jsx`
- Status dot: color-coded `green/yellow/red` based on mailbox health aggregate — `Layout.jsx`, `index.css`
- Tooltip on status dot listing mailbox names and individual health states — `Layout.jsx`, `index.css`

**Acceptance criteria:**
- Counts update reactively when store changes
- Dot color reflects worst-case mailbox health (red if any critical)
- Tooltip accessible via keyboard focus on dot
