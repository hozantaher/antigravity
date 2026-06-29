# Search (module)

Vertical-axis module — see `plan.md` §2. Finds auction items: diacritic-insensitive fulltext (`q`)
combined with structured facet filters over the existing `items` columns.

- **Top node (UX/UI):** `ui/SearchFilters.vue`, `ui/SearchResults.vue` (auto-imported as `<SearchFilters>`, `<SearchResults>`).
- **Contract:** `contract.ts` — the `SearchQuery` type (+ `Item`/`Paginated` response shape) the UI + logic bind to, re-exported from the central `models/` barrel (decision §7.2). Search API: `GET /api/search?q&facets&page,pageSize` → `Paginated<Item>` (unchanged contract; back-compatible facet extension).
- **Bottom node:** the pure `SearchQuery` model (`parseSearchQuery`/`searchQueryToRecord`/`isEmptySearch`/`normalizeYearRange`) — serializable so a future saved-search domain can persist + re-run it.
- **Behind the contract (swappable impl):** `logic/useSearchFilters.ts` (auto-imported via `imports.dirs: features/*/logic`); the faceted query + fulltext in `searchPage`/`itemRepo` + `unaccentLikeAny` stay under `server/`. The documented Algolia swap is a drop-in behind the same `/api/search` HTTP surface.

Facets: `type`, `categoryId`, price range (`priceMin`/`priceMax`), vehicle attributes (`fuelType`, `bodyType`, `transmission`, `driveType`, `color`), registration-year range (`yearFrom`/`yearTo`). No new table/migration — read-only projection over `items` (trgm/GIN indexes from migrations 014/015).

Ordering (node `ordering/`): the `?sort` param picks the result order — `newest` / `priceAsc` / `priceDesc`, with the default `relevance` meaning the shared listing order (status rank + tie-breaks) and sending **no** param. Sort is presentation, kept out of `SearchQuery` (so it never enters the saved-search shape or the query round-trip); `useSearchFilters` owns it, mirrors it to the URL like a facet, and the repo maps it to a deterministic `ORDER BY` via the pure `searchOrderKey`. An explicit sort orders **active** items by the chosen key but sinks terminal listings (sold/closed — `STATUS_RANK`'s bottom tier) last, so a sold car never tops a price- or recency-sorted search (mirrors how the default order treats the same tier). Proofs: `tests/unit/searchSort.test.ts` (parse + key selection), `tests/nuxt/useSearchFilters.test.ts` (query/URL wiring), `tests/server/api/publicReads2.test.ts` (API forwards the parsed sort); the actual `ORDER BY` row-ordering — including the sold-last tiering — is exercised by `tests/integration/repos.test.ts` (the `searchPage sorts active items…` case, runs under the Docker test DB).

Self-measure: `pnpm module:signal search`.
