# Reference Data (module)

Vertical-axis module — see `plan.md` §2.

- **Top node (UX/UI):** `ui/CategoriesGrid.vue`, `ui/FlagBadge.vue` (auto-imported as `<CategoriesGrid>`, `<FlagBadge>`).
- **Contract:** `contract.ts` — the data types the UI + logic bind to (`Category`, `CategoryParam`, `Country`, `Currency`, `Language`), re-exported from the central `models/` barrel (decision §7.2). API surface: `GET /api/{categories,category-params,countries,currencies,languages}`.
- **Bottom node (pure data):** those model types — not physically moved (decision §7.2).
- **Behind the contract (swappable impl):** `logic/use{Categories,Countries,Currencies,Languages}.ts` (auto-imported via `imports.dirs: features/*/logic`); seed/source `server/data/fixtures.ts` (stays); thin Nitro handlers `server/api/*.get.ts`.

> `composables/admin/useAdminCategoryLabel.ts` is admin-namespaced — it stays under `composables/admin` and migrates with the admin module (P6).

Self-measure: `pnpm module:signal reference-data`.
