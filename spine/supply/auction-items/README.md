# Auction Items (module)
![Version](https://img.shields.io/badge/version-v1.3.3-blue)


Vertical-axis module — see `plan.md` §2.

- **Top node (UX/UI):** `ui/*.vue` — the moved auction-item components, auto-imported by bare name: `<CompareDock>`, `<ItemsGridSkeletor>`, `<NoItems>`, `<ContactForm>`, `<ItemCard>`, `<ItemContact>`, `<ItemDescription>`, `<ItemInfo>`, `<ItemLocation>`, `<ItemStatus>`, `<ItemsGrid>`, `<ItemsListing>`, `<StaticMap>`.
- **Contract:** `contract.ts` — the data types the UI + logic bind to (`Item`, `LiveItem`, `RecentItem`, `Price`, `Address`, `Gps`, `Winner`, `Paginated`), re-exported from the central `models/` barrel (decision §7.2). API surface (read): `GET /api/items`, `GET /api/item/[id]`, `GET /api/items/live`, `GET /api/items/sold`.
- **Bottom node (pure data):** those model types — not physically moved (decision §7.2).
- **Behind the contract (swappable impl):** `logic/use{Compare,Favorites,ItemDetail,LiveItemStatus,PagedItems}.ts` (auto-imported via `imports.dirs: features/*/logic`); server-side `server/repos/itemRepo.ts` + `server/repos/mappers.ts` stay under `server/`.

Self-measure: `pnpm module:signal auction-items`.
