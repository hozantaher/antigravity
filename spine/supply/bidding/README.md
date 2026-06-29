# Bidding (module)
![Version](https://img.shields.io/badge/version-v1.3.3-blue)


Vertical-axis module — see `plan.md` §2.

- **Top node (UX/UI):** `ui/BidRow.vue`, `ui/ItemBids.vue` (auto-imported as `<BidRow>`, `<ItemBids>`).
- **Contract:** `contract.ts` — the `Bid` type the UI + logic bind to, re-exported from the central `models/` barrel (decision §7.2). Bid API: `POST /api/item/[id]/bid`. List API: `GET /api/item/[id]/bids`.
- **Bottom node:** the `Bid` model — not physically moved (decision §7.2).
- **Behind the contract (swappable impl):** `logic/useItemBids.ts` + `logic/useLiveItems.ts` (auto-imported via `imports.dirs: features/*/logic`); server-side bid eligibility gate `isUserEligibleToBid` + soft-close in the bid handler/`itemRepo` stay under `server/`.

Self-measure: `pnpm module:signal bidding`.
