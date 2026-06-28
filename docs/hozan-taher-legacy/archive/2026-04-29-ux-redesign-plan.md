# UX Redesign — Plan + Sprints

**Status**: in flight (F1–F14 stacked, awaiting merge cycle).
**Owner**: Tomáš.
**Started**: 2026-04-28 (after `/mailboxes` was flagged as the visual reference).
**Anchor doc**: `docs/initiatives/2026-04-28-operator-flow-architecture.md`.
**Design guide**: `docs/design/page-template.md` (canonical primitive spec).

---

## 0. North star

`/mailboxes` is the design reference. Every dashboard page should follow:

```
PageHead{ stats: PageStatStrip, actions: [...] }
PageToolbar{ search, filters, ChipGroup, FilterCount }
table   ← row click opens drawer via ?<entity>=<id>&tab=<x> URL params
```

**Brutal simplification mandate** (user, 2026-04-28): cut visible
complexity. Hide rarely-used controls behind toggles. Don't ship two
summary surfaces for the same data. Default to the daily-ops view, not
the all-features view.

---

## 1. State of art (2026-04-29)

### Shipped (F1–F14, 14 stacked PRs + 1 standalone)

| PR  | Branch                              | Scope                                                                  |
| --- | ----------------------------------- | ---------------------------------------------------------------------- |
| 116 | `feat/mailbox-campaigns-cross-link-s4` | S4 — Mailbox ↔ Campaigns cross-link + S2/S3 test fixes (independent of F-stack) |
| 117 | `feat/ux-design-primitives`         | F1 — `<PageHead>`/`<PageStatStrip>`/`<PageToolbar>`/`<Chip>` + design guide |
| 118 | `feat/ux-replies-redesign-f2a-on-f1` | F2a — `/replies` redesign + URL filters (`?handled` / `?classification` / `?campaign_id`) |
| 119 | `feat/ux-drop-dashboard-f2c`        | F2c — drop `/dashboard`, route `/` → `/replies?handled=false`           |
| 120 | `feat/ux-campaigns-redesign-f2b`    | F2b — `/campaigns` redesign + chip status filter                       |
| 121 | `feat/ux-sidebar-split-f3`          | F3 — sidebar split Denně / Setup / Engineering (collapsible)           |
| 122 | `feat/ux-segments-redesign-f4`      | F4 — `/segments`                                                       |
| 123 | `feat/ux-leads-redesign-f5`         | F5 — `/leads` + URL filter                                             |
| 124 | `feat/ux-templates-redesign-f6`     | F6 — `/templates`                                                      |
| 125 | `feat/ux-contacts-redesign-f7`      | F7 — `/contacts`                                                       |
| 126 | `feat/ux-scoring-redesign-f8`       | F8 — `/scoring`                                                        |
| 127 | `feat/ux-engineering-pages-f9`      | F9 — Watchdog / Observability / Inbox                                  |
| 128 | `feat/ux-e2e-nav-cleanup-f10`       | F10 — e2e nav specs sync with F2c+F3                                   |
| 129 | `feat/ux-companies-toolbar-f11`     | F11 — `/companies` toolbar primitives (CSS rename)                     |
| 130 | `feat/ux-companies-simplification-f12` | F12 — `/companies` EnrichmentBar drop + filter collapse              |
| 131 | `feat/ux-companies-essentials-f13`  | F13 — `/companies` stat strip 7→4 + filter labels drop                 |
| 132 | `feat/ux-companies-filter-summary-f14` | F14 — `/companies` inline filter summary pills                       |

### Coverage matrix

| Page              | Stat strip | Toolbar primitives | Drawer pattern | Notes                                       |
| ----------------- | :--------: | :----------------: | :------------: | ------------------------------------------- |
| `/mailboxes`      | ✓ (ref)    | ✓ (ref)            | ✓ (ref)        | F1 used as the design source                |
| `/replies`        | ✓ F2a      | ✓ F2a              | slide-over     | URL filters wired                           |
| `/campaigns`      | ✓ F2b      | ✓ F2b              | n/a (full page detail) | Detail page deferred (Sprint C)     |
| `/segments`       | ✓ F4       | n/a (modal create) | ✓ (legacy)     | Drawer existed pre-stack                    |
| `/leads`          | ✓ F5       | ✓ F5               | n/a            | URL filter wired                            |
| `/templates`      | ✓ F6       | n/a                | n/a            | Card grid main view                         |
| `/contacts`       | ✓ F7       | ✓ F7               | slide-over     |                                             |
| `/scoring`        | ✓ F8       | n/a (settings)     | n/a            | Verze/edits stat                            |
| `/companies`      | ✓ F1+F13   | ✓ F11+F14          | ✓ legacy       | Most polish — stat strip, summary, density  |
| `/watchdog`       | ✓ F9       | n/a                | n/a            | Event timeline                              |
| `/observability`  | ✓ F9       | n/a                | n/a            | Synthetic health KPIs                       |
| `/inbox`          | ✓ F9       | ✓ F9               | slide-over     | Same chip language as `/replies`            |
| `/analytics`      | n/a        | n/a                | n/a            | Rich KPI grid serves as stat strip          |

### Out of scope (intentionally not in F-stack)

- **CampaignDetail (`/campaigns/:id`)** — detail-page header (back / name / status badge / description) doesn't fit `<PageHead>` (which is for list pages with stat strips). Follow-up: Sprint C.
- **Companies bulk actions** — table currently has no multi-select. Sprint B.
- **Density toggle** — only `/mailboxes` has Compact/Comfort. Sprint B.

---

## 2. Sprints

### Sprint A — Stack landing (operational, blocking)

**Goal**: get F1–F14 + S4 into `main` without losing the stack-rebase
sanity.

**Tasks**

- [ ] A1 — Land **#116 (S4)** first. It's independent and fixes the
      pre-existing S2/S3 test cascade that everything else inherits.
      Once it's in `main`, the F-stack tests stop showing 12 red.
- [ ] A2 — Land **F1 (#117)**. Foundation for everything after.
- [ ] A3 — Land **F2a (#118)** rebased onto post-F1 main.
- [ ] A4 — Land **F2c (#119)** rebased.
- [ ] A5 — Land **F2b (#120)** rebased.
- [ ] A6 — Land **F3 (#121)** rebased.
- [ ] A7 — Land **F4–F9 (#122–#127)** in order. Each rebases onto the
      previous post-merge main; conflicts should be minimal because
      each PR isolates one page.
- [ ] A8 — Land **F10 (#128)** — e2e cleanup.
- [ ] A9 — Land **F11–F14 (#129–#132)** in order. All four touch
      Companies; rebase order matters.

**Gates**

- All in-stack PR tests must pass post-rebase. The 12 pre-existing
  tests fixed by #116 should be green from #117 onward.
- Build clean (no chunk-size regression beyond the existing warning).
- Manual smoke: visit each redesigned route (`/replies`,
  `/campaigns`, `/mailboxes`, `/companies`, `/segments`, `/leads`,
  `/templates`, `/contacts`, `/scoring`, `/watchdog`,
  `/observability`, `/inbox`) — stat strip + toolbar render.

**Strategy**: rebase merge, not squash. The stack was authored as 15
discrete commits with clear messages; squash-merging the bottom of
the stack would force every above PR into a 5-commit replay. Rebase
preserves history.

**Estimate**: 1 working day if no surprises; 2 days if one of the
F-PRs has a non-trivial conflict with a parallel branch.

---

### Sprint B — List page polish (after stack lands)

**Goal**: bring the table-driven list pages to feature parity with
`/mailboxes`. Density, bulk, sticky header, sortable columns where
useful.

**Tasks**

- [ ] B1 — **Density toggle primitive**. Promote `/mailboxes`
      `mb-density-comfort` / `mb-density-compact` into a shared
      `<DensityToggle>` component + `.density-comfort`/`.density-compact`
      CSS scope. localStorage key per page (e.g.
      `co.density`, `replies.density`). Apply on `/companies`,
      `/replies`, `/contacts`, `/leads`, `/inbox`.
- [ ] B2 — **Sticky table header**. CSS-only —
      `thead { position: sticky; top: 0; background: var(--surface) }`.
      Affects every `.table-wrap` page. One PR for all of them.
- [ ] B3 — **Bulk select** on `/companies` (pick multiple firms →
      bulk verify-email / add to segment / spustit kampaň pro
      výběr). Reuse Mailboxes' bulk-bar pattern
      (`mb-bulkbar` block).
- [ ] B4 — **Sortable column headers** on `/companies` already partial
      (Firma + Skóre). Add Město + E-mail jistota. `/contacts`
      currently has none — at least Email + Status.
- [ ] B5 — **Pagination footer** standardised. Currently each list
      page rolls its own "load more" / "next 50" approach. Promote
      to a `<PageFooter>` primitive with consistent `<X> z <Y>` text.

**Estimate**: 3–5 PRs, ~2 working days.

---

### Sprint C — Detail page alignment

**Goal**: align detail pages (currently bespoke headers) with the rest
of the dashboard without forcing them into the list-page primitive.

**Tasks**

- [ ] C1 — **CampaignDetail header**. Keep back-arrow + name + status
      pill, but standardise spacing + button positioning. Move the
      KPI strip (queued/sent/opened/replied/bounced) into a
      `<PageStatStrip>` so the visual treatment matches `/companies`.
      Tabs (S3) stay; they're already on-brand.
- [ ] C2 — **CampaignDetail Odpovědi / Problémy tabs** — use the
      same `ChipGroup` for filter chips inside each tab as the
      list pages.
- [ ] C3 — **ThreadDetail (`/replies/:id`)** — hoist the bespoke
      header into a small `PageBackHead` primitive (back arrow +
      title + status pill). Then reuse on CampaignDetail (C1).
- [ ] C4 — **Slide-over drawer pattern audit**. `/replies`,
      `/inbox`, `/contacts` all have slide-overs. They differ in
      width, padding, header treatment. Promote to a single
      `<SlideOverDrawer>` shape (or reuse the `/mailboxes` Drawer
      primitives where it fits).

**Estimate**: 4 PRs, ~3 working days. C3 (PageBackHead) blocks C1.

---

### Sprint D — Quality debt sweep

**Goal**: clear the 13 deferred MEDIUM items from the 2026-04-22
audit (`project_quality_debt_summary.md` memory entry).

**Tasks** (placeholder; needs reading the audit doc to enumerate)

- [ ] D1 — Read `docs/audits/2026-04-22-quality-rollup.md`, extract
      the 13 deferred MEDIUMs into individual GH issues.
- [ ] D2–D14 — One issue per item. Triage: drop, fix, or document
      as accepted debt.

**Estimate**: 1 working day for triage; per-item effort varies.

---

### Sprint E — Engineering pages polish

**Goal**: the Engineering nav section (collapsed by default after F3)
contains `/analytics`, `/watchdog`, `/observability`. F9 brought
Watchdog + Observability + Inbox to stat-strip parity. Open work:

**Tasks**

- [ ] E1 — **/analytics primitives review**. The page has its own
      rich KPI grid (5 cards with icons + sub-labels) which we
      intentionally skipped in F9. Revisit: do we promote those
      KPIs into a `<PageStatStrip>` with bigger size, or leave the
      grid as-is? Decision needed; if leave, document why in the
      design guide.
- [ ] E2 — **/observability test-quality card** — currently bespoke.
      If it's the only signal worth dragging into PageStatStrip,
      consolidate.
- [ ] E3 — **/watchdog event timeline** — works fine but uses a
      hand-rolled grid layout. If we ever add filters here,
      promote to `<PageToolbar>` + `<ChipGroup>`.

**Estimate**: 2 PRs if we make changes, otherwise just a design-guide
note.

---

### Sprint F — Operator-flow second wave

**Goal**: extend the operator flow that S1–S4 started (Reply ↔
Campaign, Companies → Campaign, CampaignDetail tabs, Mailbox ↔
Campaign cross-link). Now that the redesign is done, fill remaining
cross-page gaps that surfaced.

**Tasks**

- [ ] F-S1 — **`/replies` deep-link from `/companies`**. After
      operator filters firms (e.g. by ICP=Ideal + region=Praha),
      add a "Zobrazit odpovědi z těchto firem" action that opens
      `/replies` filtered by `?company_ids=<list>` (BFF needs to
      accept ico-list). Closes the contact loop.
- [ ] F-S2 — **Saved-pohled bulk-launch**. PresetDropdown lets
      operators save filter states. Add "Použít v kampani" inline
      on each preset row (currently only on the active filter).
- [ ] F-S3 — **Drill-in from `/replies` stat strip**. Click
      "Odpovědí: 12" stat → filter `/replies` to that classification.
      Same UX as Mailboxes status counts → drawer.
- [ ] F-S4 — **`/leads` → CampaignDetail**. From a lead row, link to
      the campaign that produced it (campaign_name already on row).
      Currently no link.

**Estimate**: 4 small PRs, each ~half day. Lower priority than
Sprint A/B/C.

---

### Sprint G — Tests-as-Heart Phase 3

**Goal**: backstop the redesign. Phase 3 (synthetic monitoring) is
already in the broader plan; this sprint scopes its UI surface.

**Tasks**

- [ ] G1 — `/observability` already shows synthetic-monitor data.
      Make sure post-F9 the stat strip's "Spuštění · 100" /
      "Pass" / "Fail" / "Avg duration" actually pulls from
      `/api/synthetic-runs` correctly (audit during stack merge).
- [ ] G2 — When a synthetic run fails, surface a `<PageStatStrip>`
      err-tone badge on the relevant route's stat strip
      (Replies if `synthetic-replies` failed, etc.). Optional;
      requires synthetic-monitor enrichment.

**Estimate**: 1–2 PRs depending on G2 scope.

---

## 3. Cross-cutting concerns

### Memory hygiene

- `feedback_long_stacks_ok.md` (added 2026-04-29) covers the deep-stack
  rebase tolerance.
- After Sprint A lands the F-stack, write a **`project_design_language.md`**
  memory pointing to `docs/design/page-template.md` so future agents
  default to the primitive when redesigning.

### Communication policy

- One PR = one page or one primitive. F-stack honours this.
- Each PR's body must list the rebase order if stacked.
- Test fixes inherited from a parent PR get a single-line note in the
  child PR's body ("picked up the S2 cascade fix waiting in #116…")
  to make the diff readable.

### Test strategy

- Unit tests for primitives (`tests/unit/components/page-primitives.test.jsx`).
- Per-page tests for the stat strip + chip filters (group landmark, URL filter round-trip).
- E2E smoke for the 4 daily routes (Replies / Campaigns / Mailboxes / Companies).

### What we're not building

- ❌ No "advanced filter builder" page (segments handle this).
- ❌ No CampaignDetail single-page-app — keep tabs (S3).
- ❌ No theme switcher polish — light/dark already works.
- ❌ No sidebar customisation (drag-to-reorder etc) — premature.
- ❌ No "marketing" landing page — we're a dashboard.

---

## 4. Acceptance signal (initiative complete when…)

1. Stack merged into main (Sprint A done).
2. Density toggle primitive shipped to ≥4 list pages (Sprint B1).
3. CampaignDetail header consistent with the rest of the dashboard
   (Sprint C1+C3 done).
4. Memory entry `project_design_language.md` written.
5. User reviews `/companies`, `/replies`, `/campaigns`, `/mailboxes`
   side-by-side and signs off ("ano, sjednoceno").

Sprint D/E/F/G are nice-to-have follow-ups, not initiative gates.

---

## 5. Anti-goals

- Do **not** make /companies the source of design changes that ripple
  into other pages. The reference is `/mailboxes`. If Companies needs
  X and Mailboxes doesn't have X, propagate X back to the primitive
  first, then apply.
- Do **not** add new top-level nav items. The 4-quad primary
  (Replies / Campaigns / Mailboxes / Firmy) is the contract.
- Do **not** ship a redesign PR that lands without unit-test updates.
  Cascading test failures are how the F-stack inherited the S2/S3
  cascade — avoidable.
- Do **not** rebuild the dashboard with a third-party UI kit (Radix /
  shadcn / chakra). The handcrafted primitives are 800 lines total
  and replace ~300 lines of vendor surface — keep it lean.
