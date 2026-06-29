import type { Winner } from './Winner'
import type { AdHighlight } from './AdHighlight'
import type { Bid } from './Bid'
import type { Price } from './Price'
import type { Gps } from './Gps'
import type { FuelType, Transmission, BodyType, DriveType, VehicleColor, VehicleSpecs } from './VehicleSpecs'

export interface Item {
  id: string
  internalId?: string
  title: string
  image: string
  images: string[]
  images360: string[]
  description: Record<string, string>
  highlights: Record<string, AdHighlight[]>
  minimalPrice?: Price
  priceFrom?: Price
  categoryId: string
  userId: string
  bids: Bid[]
  // List/card payloads carry only the last bid in `bids` to stay small; bidCount is the true
  // total for the "N bids" label. Undefined on the full detail payload (use bids.length there).
  bidCount?: number
  minBid?: Price
  location?: string
  countryCode?: string
  youtubeVideoId?: string
  priceHighlighted: boolean
  taxIncluded: boolean
  sold: boolean
  closed: boolean // is Auction closed?
  hidden: boolean
  winner?: Winner
  email?: string
  phone?: string
  startDate?: number // epoch millis (was Firebase Timestamp)
  endDate?: number // epoch millis
  type: ItemType
  created?: number
  updated?: number
  visibleUpdated?: number
  gps?: Gps
  vin?: string
  fuelType?: FuelType
  transmission?: Transmission
  bodyType?: BodyType
  driveType?: DriveType
  enginePowerKw?: number
  engineDisplacementCcm?: number
  color?: VehicleColor
  firstRegistrationDate?: string
  specs?: VehicleSpecs
}

export enum ItemType {
  auction = 'auction',
  ad = 'ad',
}

export enum ItemStatus {
  BuyNow = 1,
  AuctionSoon,
  AuctionLive,
  AuctionEnd,
  AuctionProcessing,
  Sold,
}

export const itemCurrentPrice = (item: Item): Price | undefined => {
  if (item!.bids.length === 0) return item.priceFrom

  // last bid
  return item.bids[item.bids.length - 1]
}

export const hasAuctionStarted = (item: Item): boolean => {
  if (!item || !item.startDate || !item.endDate) return false
  return item.startDate < Date.now()
}

export const hasAuctionEnded = (item: Item): boolean => {
  if (!item) return false
  if (!item.endDate || !item.startDate) return true
  return item.endDate < Date.now()
}

export const isAuctionLive = (item: Item): boolean => {
  if (!item || !item.startDate || !item.endDate) return false
  const now = Date.now()
  return item.startDate < now && item.endDate > now
}

export const itemStatus = (item: Item): ItemStatus => {
  if (item.sold) return ItemStatus.Sold

  if (item.type === ItemType.ad) {
    return ItemStatus.BuyNow
  } else {
    if (hasAuctionEnded(item) && !item.closed) return ItemStatus.AuctionProcessing
    if (hasAuctionEnded(item)) return ItemStatus.AuctionEnd
    if (isAuctionLive(item)) return ItemStatus.AuctionLive

    return ItemStatus.AuctionSoon
  }
}

const statusOrder: Record<ItemStatus, number> = {
  [ItemStatus.AuctionLive]: 1,
  [ItemStatus.AuctionProcessing]: 1,
  [ItemStatus.BuyNow]: 2,
  [ItemStatus.AuctionSoon]: 3,
  [ItemStatus.AuctionEnd]: 4,
  [ItemStatus.Sold]: 4,
}

export const defaultSort = (a: Item, b: Item) => {
  const aStatus = itemStatus(a)
  const bStatus = itemStatus(b)

  if (aStatus === bStatus) {
    if (aStatus === ItemStatus.AuctionLive) return (a.endDate ?? 0) - (b.endDate ?? 0)

    return (b.visibleUpdated ?? 0) - (a.visibleUpdated ?? 0)
  }

  return (statusOrder[aStatus] ?? 0) - (statusOrder[bStatus] ?? 0)
}

export const isMinPriceReached = (item: Item): boolean => {
  if (!isAuctionLive(item)) return true
  if (!itemCurrentPrice(item)?.amount || !item.minimalPrice?.amount) return true
  return itemCurrentPrice(item)!.amount! > item.minimalPrice!.amount!
}

// Localized item content (description/highlights) is keyed by locale code, except Serbian, which
// is stored under `srb` rather than the `rs` locale code. Resolve the storage key here so every
// reader (display, <meta description>, JSON-LD) stays consistent.
export const contentLocaleKey = (locale: string): string => (locale === 'rs' ? 'srb' : locale)

// SEO slug for an item's public URL, derived from the listing title: diacritics stripped, lowercased,
// non-alphanumerics collapsed to single hyphens, capped at 80 chars. Title-only (not specs) so a grid
// card — whose payload omits specs — yields the SAME slug as the detail page and never forces a
// redirect. Purely cosmetic: the id segment resolves the page, so the slug can change freely.
export const itemSlug = (item: Pick<Item, 'title'>): string =>
  (item.title ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')

// Canonical, locale-agnostic path for an item: /item/<id>/<slug>, with the slug dropped when it would
// be empty (e.g. a non-Latin title). The id is the only resolving segment; NuxtLinkLocale / localePath
// add the locale prefix. Keeping the id as its own segment means the (opaque) id charset never clashes
// with the slug.
export const itemPath = (item: Pick<Item, 'id' | 'title'>): string => {
  const slug = itemSlug(item)
  return slug ? `/item/${item.id}/${slug}` : `/item/${item.id}`
}
