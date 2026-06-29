// Reference Data — module contract (binds the UI top-node + logic to the data bottom-node).
//
//   top node      ./ui/CategoriesGrid.vue, ./ui/FlagBadge.vue — auto-imported as <CategoriesGrid>, <FlagBadge>
//        │        (props/emits are each component's own surface)
//   contract      this file — the data types the UI + logic bind to
//        │        API surface: GET /api/{categories,category-params,countries,currencies,languages}
//   bottom node   pure, stateless data structures, re-exported here as the module's
//                 contract-tagged subset of the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/use{Categories,Countries,Currencies,Languages}
// (auto-imported via imports.dirs features/*/logic); seed source server/data/fixtures.ts (stays —
// tsx relative-import constraint); thin Nitro handlers server/api/*.get.ts.
export type { Category, CategoryParam, Country, Currency, Language } from '~/models'
