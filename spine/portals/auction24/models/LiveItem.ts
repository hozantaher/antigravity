import type { Bid } from './Bid'
import type { Item } from './Item'
import type { Winner } from './Winner'

// Slim per-item state that changes over an auction's life: the current price (carried by the
// newest bid), the bid count, the (soft-close-extended) end, and the close/winner. The live
// layer (useLiveItems) polls /api/items/live for these and overlays them onto card / detail
// items so viewers see new bids and an extended countdown without a manual refresh.
export interface LiveItem {
  id: string
  // Newest bid — drives the current price (itemCurrentPrice reads the last bid). Absent until
  // the first bid, when the price falls back to priceFrom.
  lastBid?: Bid
  bidCount: number
  endDate?: number // epoch ms; may be soft-close-extended past the original end
  sold: boolean
  closed: boolean
  winner?: Winner
}

// Overlay live state onto an item, returning a NEW item (never mutates the input) so a computed
// can depend on it cleanly. Mirrors cardRowToItem: the last bid becomes the whole `bids` array
// (cards/grids only ever read the last one), with the true total kept in bidCount.
export const applyLiveItem = (item: Item, live: LiveItem): Item => ({
  ...item,
  bids: live.lastBid ? [live.lastBid] : [],
  bidCount: live.bidCount,
  endDate: live.endDate,
  sold: live.sold,
  closed: live.closed,
  winner: live.winner,
})

// Has anything the detail page renders actually moved versus the full item it holds? Drives the
// "refetch the full item only on a real change" probe: the slim poll is cheap, the heavy refetch
// fires only here. The full detail item leaves bidCount undefined, so fall back to bids.length.
export const liveItemChanged = (item: Item, live: LiveItem): boolean =>
  live.bidCount !== (item.bidCount ?? item.bids.length) ||
  live.endDate !== item.endDate ||
  live.sold !== item.sold ||
  live.closed !== item.closed
