# Mailboxes UI Polish — Sprints

Follow-on plan after the 2026-04-20 session where the filter/table redesign landed (status dot, unified toolbar, row hover actions, tinted rows, merged Limit column, conditional Warmup column, "Nikdy" label).

This plan covers the **remaining rough edges** on the Mailboxes page — areas we deliberately left untouched in the previous iteration to avoid a big-bang refactor regression.

## Guiding principles (session learnings)

1. **Incremental wins over big-bang.** The earlier 5-sprint modularization was fully reverted because it lost visual fidelity despite passing tests. Prefer small, visually verifiable changes.
2. **Design checkpoints before code.** For anything touching layout/hierarchy, propose 2–3 directions first and ship only after user confirms.
3. **Labels beat icons.** Dots/icons without labels = hádanka. Always pair visual cues with text, or give them a dominant-color + hover tooltip.
4. **Remove clutter, don't add.** Zero-count chips, redundant headings, text-heavy dividers → out. Density is the enemy.
5. **Reversible commits.** Each sprint is one commit on `wm/new-features` so revert cost is low.

## Current state snapshot (2026-04-20)

Landed in this session:
- `src/pages/Mailboxes.jsx`: unified 1-row toolbar, status dropdown with counts, health chips (non-zero only), result counter pill, hover actions (pause/edit), row tinting, Warmup auto-hide, "Nikdy" for empty last-send.
- `src/index.css`: `.mb-filter-select`, `.mb-health-chip*`, `.mb-filter-count`, `.mb-row-action*`, `.mb-delivery-sub`, status-based row tints.

Build green at `515.92 kB` JS / `69.55 kB` CSS.

## Sprints

### S1 — Page header stat strip

**Scope:** `.page-head-stats` in `src/pages/Mailboxes.jsx` lines 1368–1383.

**Today:** bland inline text — `3 aktivních · 1 pozastavených · 4 celkem · 150 e-mailů/den`.

**Options to propose:**
- A) Small KPI tiles with icon + number + label (4 tiles, equal width, subtle border).
- B) Horizontal stat strip with color-dot prefix per status, tabular numbers, subtle separators.
- C) Keep text, just tighten typography (biggest number, muted label).

**Acceptance:**
- Reads at a glance (primary stat dominant).
- Scales to 1–4 stats depending on `paused > 0` / `dailyCap > 0`.
- Does not push table below-the-fold on 1440p.
- Visual parity with `.drawer-metric` tokens so it feels in-family.

**Estimated touch:** ~30 lines JSX, ~40 lines CSS.

**Revert:** `git checkout -- src/pages/Mailboxes.jsx src/index.css`.

---

### S2 — AnonymizationBar

**Scope:** `AnonymizationBar` component, `src/pages/Mailboxes.jsx` lines 811–867.

**Today:** dense one-liner mixing anti-trace status, proxy pool health, unhealthy-mailboxes count, and a refresh button. Heterogeneous info packed tight.

**Problems:**
- Three different concerns (relay / pool / alert) compete for eye attention.
- `CheckCircle`/`XCircle` icons + `mb-anonbar-ok`/`err` classes repeat.
- Proxy count string `5 funkčních proxy (3 CZ) z 20` is long and hard to scan.

**Options to propose:**
- A) Split into two pills (Anti-trace / Proxy pool) + separate alert banner when `unhealthy > 0`.
- B) Keep one bar but reformat: `[● Anti-trace 45ms]  [● 5/20 proxy · 3 CZ]  [⚠ 2]   [↻]`.
- C) Collapse to a single "Infrastructure: OK" pill that expands on click.

**Acceptance:**
- Alert (`unhealthy > 0`) is visually distinct from steady-state info.
- `cached_at` timestamp still reachable (tooltip if removed from default view).
- Refresh button preserves current behavior (spinner + disabled).

**Estimated touch:** ~50 lines JSX, ~60 lines CSS.

**Revert:** single-file checkout.

---

### S3 — Drawer polish

**Scope:** `Drawer` component in `src/pages/Mailboxes.jsx` (opens on row click). Intentionally untouched in S1 because the previous refactor broke drawer UX.

**Today:** sections for Overview / Settings / Alerts tabs, keyboard shortcuts (J/K/E/P/R/1/2/3), sibling navigation, diagnostics copy.

**Candidates for polish (pick before starting):**
- Tab indicator (underline vs chip active state)
- Overview metrics grid spacing
- Alert list tone classes (currently `tone-err` / `tone-warn`)
- Footer action bar (Pause / Edit / Delete) — align with row hover actions for consistency

**Explicit non-goals:**
- Do not restructure into sub-components. Last attempt reverted; keep it monolithic.
- Do not change keyboard shortcut bindings.

**Acceptance:**
- All three tabs still render without layout shift.
- Keyboard shortcuts still work (manual smoke: `j`, `k`, `e`, `p`, `1`, `2`, `3`, `Esc`).
- No visual regression vs current state unless explicitly approved per change.

**Estimated touch:** ~40 lines JSX, ~80 lines CSS.

**Revert:** single-file checkout.

---

### S4 — Modals + empty states

**Scope:**
- `MailboxModal`, `CsvImportModal` — creation/edit flows.
- Empty states (lines 1482–1494).
- Confirm dialog (delete).

**Today:** Modals use the shared `Modal` component. Empty states are `.ph` (placeholder) with icon + text + CTA. Generic feel.

**Options to propose for empty states:**
- A) Keep `.ph` pattern, just improve copy ("Přidejte první schránku a začněte rozesílat" with a 2-sentence hint).
- B) Illustrated empty state (light SVG + copy + CTA).
- C) Contextual empty states (different copy for "no mailboxes ever" vs "no results for this filter").

**Modals:** audit for consistency in padding, field order, validation feedback. No structural rewrite.

**Acceptance:**
- Both empty states (`mailboxes.length === 0` vs filtered-to-zero) have distinct, helpful copy.
- Modal field tab order is correct.
- Form validation errors visible inline (not just toast).

**Estimated touch:** ~30 lines JSX, ~30 lines CSS.

**Revert:** single-file checkout.

---

### S5 (stretch) — Keyboard + responsive

**Scope:** page-level keyboard shortcuts + mobile layout.

**Today:**
- Drawer-level shortcuts only (when drawer open).
- Mobile: `.table-wrap { overflow-x: auto }` so table scrolls horizontally. No mobile-tailored row layout.

**Candidates:**
- `/` focuses search input.
- `Esc` clears search + filters when no drawer open.
- `n` opens "Add mailbox" modal.
- Mobile breakpoint (<768px): consider card layout instead of horizontal scroll.

**Explicit non-goals:**
- No React Router changes.
- No mobile-first rewrite.

**Acceptance:**
- Shortcuts don't fire while user is typing in any input/textarea/select.
- Shortcuts are discoverable (tooltip or `?` help overlay — separate decision).
- No regression on keyboard focus traps around the drawer.

**Estimated touch:** ~50 lines JSX, ~100 lines CSS (mostly responsive).

---

## Cross-sprint checklist

Before each sprint commit:
- [ ] `pnpm build` green
- [ ] Manually open Mailboxes page, verify drawer opens/closes, filters apply, hover actions work
- [ ] Confirm no console errors/warnings introduced
- [ ] `git diff --stat` sanity-check (no accidental file deletions)
- [ ] Commit message follows `type(scope): short` format on `wm/new-features`

## Out of scope

- Dashboard/Campaigns/Templates/Segments pages — separate plans.
- Backend / BFF / Go service changes.
- i18n — Mailboxes is Czech-only (per project convention).
- Test suite additions — existing `Mailboxes.components.test.jsx` must still pass, nothing new required.

## Session references

- Revert point: commit `a4d7427` on `wm/new-features`.
- Prior reverted attempt: modularization into `src/components/mailboxes/**` (S1–S5 of previous plan).
- Main source of truth: `features/platform/outreach-dashboard/src/pages/Mailboxes.jsx` (monolithic, ~1670 lines, intentionally kept that way).
