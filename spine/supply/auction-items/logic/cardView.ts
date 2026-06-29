import { isAuctionLive, itemCurrentPrice, type Item, type Price } from '~/models'

// The projection an ItemCard renders. Built once here so every surface (listing grid,
// recommendation rail) derives price/bidCount/live identically; callers supply the
// (possibly memoized) image/srcset since image-URL building is the expensive part.
export interface CardView {
  item: Item
  image: string
  srcset: string
  fallback: string
  price?: Price
  bidCount: number
  live: boolean
}

export const toCardView = (item: Item, media: { image: string; srcset: string; fallback: string }): CardView => ({
  item,
  image: media.image,
  srcset: media.srcset,
  fallback: media.fallback,
  price: itemCurrentPrice(item),
  bidCount: item.bidCount ?? item.bids.length,
  live: isAuctionLive(item),
})
