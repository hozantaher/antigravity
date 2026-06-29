// Auction Items — module contract (binds the UI top-node + logic to the data bottom-node).
//
//   top node      ./ui/*.vue — auction-item UI, auto-imported as <ItemCard>, <ItemsGrid>,
//        │        <ItemsListing>, <CompareDock>, … (props/emits are each component's own surface)
//   contract      this file — the data types the UI + logic bind to
//        │        API surface (read): GET /api/items, GET /api/item/[id],
//        │        GET /api/items/live, GET /api/items/sold
//   bottom node   pure, stateless data structures, re-exported here as the module's
//                 contract-tagged subset of the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/use{Compare,Favorites,ItemDetail,LiveItemStatus,PagedItems}
// (auto-imported via imports.dirs features/*/logic); server-side server/repos/itemRepo.ts +
// server/repos/mappers.ts (stay under server/).
export type { Item, LiveItem, RecentItem, Price, Address, Gps, Winner, Paginated } from '~/models'
