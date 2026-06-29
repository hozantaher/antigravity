// Search — module contract (binds the UI top-node to the search surface).
//
//   top node      ./ui/SearchFilters.vue, ./ui/SearchResults.vue —
//        │        auto-imported as <SearchFilters>, <SearchResults>
//   contract      this file — the search query + item types the UI + logic bind to
//        │        search API: GET /api/search?q&facets&page,pageSize → Paginated<Item>
//   bottom node   the pure SearchQuery model (parse/serialize/normalize facets ↔ URL),
//                 re-exported here as the module's contract-tagged subset of the central
//                 models/ barrel (decision §7.2). Item/Paginated are the response shape.
//
// Behind the contract (swappable impl): logic/useSearchFilters (auto-imported via imports.dirs
// features/*/logic); the faceted query + diacritic-insensitive fulltext in searchPage / itemRepo
// + unaccentLikeAny stay under server/ (the documented Algolia swap lives here, same contract).
export type { SearchQuery, Item, Paginated } from '~/models'
