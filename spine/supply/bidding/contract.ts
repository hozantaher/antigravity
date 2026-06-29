// Bidding — module contract (binds the UI top-node to the bid/serving surface).
//
//   top node      ./ui/BidRow.vue, ./ui/ItemBids.vue —
//        │        auto-imported as <BidRow>, <ItemBids>
//   contract      this file — the bid data types the UI + logic bind to
//        │        bid API:  POST /api/item/[id]/bid
//        │        list API: GET  /api/item/[id]/bids
//   bottom node   the pure Bid model type, re-exported here as the module's
//                 contract-tagged subset of the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/{useItemBids,useLiveItems} (auto-imported via
// imports.dirs features/*/logic); server-side bid eligibility gate isUserEligibleToBid +
// soft-close in the bid handler/itemRepo (stay under server/).
export type { Bid } from '~/models'
