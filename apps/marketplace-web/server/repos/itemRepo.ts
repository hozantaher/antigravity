import { sql, type SqlBool, type SelectQueryBuilder } from 'kysely'
import type {
  Bid,
  BodyType,
  Item,
  LiveItem,
  Paginated,
  SavedSearchItemFilter,
  SearchQuery,
  SearchSort,
  VehicleSpecs,
} from '~/models'
import { ItemType } from '~/models'
import { db } from '../utils/db'
import { categories } from '../data/fixtures'
import type { Database, ItemRow, ItemUpdate } from '../db/schema'
import {
  CARD_COLUMNS,
  cardRowToItem,
  itemToInsert,
  itemPatchToUpdate,
  rowToBid,
  rowToItem,
  toLiveItem,
  type BidSummary,
} from './mappers'
import { paginate, type PageParams } from '../utils/pagination'
import { searchOrderKey, unaccentLikeAny, type SearchOrderKey } from '../utils/search'
import { itemNeedsEnrichment } from '../utils/enrich'

const SOFT_CLOSE_MS = 3 * 60 * 1000

// Stamp an item for the enrichment sweep when it has auto-fillable work (VIN → empty specs, or a
// description with empty DeepL locales). Pure check (no runtime-config read) so item writes stay
// test-safe; the cron is what's gated by ENRICH_ENABLED. Only ever moves a row INTO 'pending'.
const stampEnrichment = async (item: Item): Promise<void> => {
  if (!itemNeedsEnrichment(item)) return
  await db
    .updateTable('items')
    .set({ enrichmentStatus: 'pending', enrichmentError: null })
    .where('id', '=', item.id)
    .execute()
}

// A bid in the last 3 minutes pushes the end out by 3 minutes; otherwise the
// end is unchanged. Pure so it can be unit-tested without a DB.
export const softCloseEnd = (endMs: number | null, nowMs: number): number | null =>
  endMs && nowMs >= endMs - SOFT_CLOSE_MS ? nowMs + SOFT_CLOSE_MS : endMs

export interface BidContext {
  type: 'auction' | 'ad'
  sold: boolean
  hidden: boolean
  closed?: boolean
  startMs: number | null
  endMs: number | null
  currentAmount: number
  increment: number
  amount: number
  nowMs: number
}

export interface BidRejection {
  status: number
  message: string
}

// Server-side auction invariants. The client gates the same rules, but the bid
// endpoint is authoritative, so it must re-check: bid only a LIVE auction
// (mirrors isAuctionLive) and only above current price + minimum increment.
// Pure so it can be unit-tested without a DB. Returns null when the bid is OK.
export const bidError = (c: BidContext): BidRejection | null => {
  if (c.type !== 'auction') return { status: 409, message: 'Item is not an auction' }
  if (c.sold || c.hidden || c.closed) return { status: 409, message: 'Auction is not open' }
  if (c.startMs == null || c.endMs == null) return { status: 409, message: 'Auction is not open' }
  if (c.nowMs < c.startMs) return { status: 409, message: 'Auction has not started' }
  if (c.nowMs >= c.endMs) return { status: 409, message: 'Auction has ended' }
  if (c.amount < c.currentAmount + c.increment) {
    return { status: 400, message: 'Bid must beat the current price by the minimum increment' }
  }
  return null
}

export interface AuctionOutcome {
  sold: boolean
  winnerUserId: string | null
}

// Outcome of an ended auction. The highest bid is the latest one (bidError enforces
// amount >= current + increment, so bids strictly increase). A winner is declared only
// when that bid meets the reserve (minimal price); a null reserve means no floor. Pure
// so it can be unit-tested without a DB.
export const decideAuctionOutcome = (
  highestBid: { userId: string; amount: number } | null,
  reserveAmount: number | null,
): AuctionOutcome =>
  highestBid && highestBid.amount >= (reserveAmount ?? 0)
    ? { sold: true, winnerUserId: highestBid.userId }
    : { sold: false, winnerUserId: null }

// One query per page (not per item): newest bid per item via DISTINCT ON + the total per item
// via a window count. A list page loads ≤1 bid row per card instead of the full bid history.
// The winner-email sweep reuses this for the winning bid (the newest bid of a sold auction).
export const loadBidSummary = async (itemIds: string[]): Promise<Map<string, BidSummary>> => {
  const byItem = new Map<string, BidSummary>()
  if (itemIds.length === 0) return byItem
  const rows = await db
    .selectFrom('bids')
    .selectAll()
    .select(sql<string>`count(*) over (partition by item_id)`.as('bidCount'))
    .distinctOn('itemId')
    .where('itemId', 'in', itemIds)
    .orderBy('itemId')
    .orderBy('date', 'desc')
    .orderBy('id', 'desc')
    .execute()
  for (const r of rows) byItem.set(r.itemId, { count: Number(r.bidCount), last: rowToBid(r) })
  return byItem
}

const attachCardData = async (rows: ItemRow[]): Promise<Item[]> => {
  const summary = await loadBidSummary(rows.map(r => r.id))
  return rows.map(r => cardRowToItem(r, summary.get(r.id)))
}

// Slim, cacheable per-item state for the live layer (the /api/items/live poll): current price
// (last bid), bid count, the soft-close-extended end, and close/winner — no heavy JSONB or full
// bid history. Two queries total regardless of N (the rows + one shared bid summary).
export const loadLiveItems = async (ids: string[]): Promise<LiveItem[]> => {
  if (ids.length === 0) return []
  const [rows, summary] = await Promise.all([
    db.selectFrom('items').select(['id', 'endDate', 'sold', 'closed', 'winner']).where('id', 'in', ids).execute(),
    loadBidSummary(ids),
  ])
  return rows.map(r => toLiveItem(r, summary.get(r.id)))
}

// Card payloads for an explicit id list, preserving that order — the recommendation
// serving path hands ranked ids here to hydrate. Carries bodyType + specs.manufacturer
// beyond CARD_COLUMNS so the client within-session re-rank (§14) has attrs to match on.
export const loadCardsByIds = async (ids: string[]): Promise<Item[]> => {
  if (ids.length === 0) return []
  const [rows, summary] = await Promise.all([
    db
      .selectFrom('items')
      .select([...CARD_COLUMNS, 'bodyType', 'specs'])
      .where('id', 'in', ids)
      .execute(),
    loadBidSummary(ids),
  ])
  const byId = new Map(rows.map(r => [r.id, r]))
  return ids.flatMap(id => {
    const r = byId.get(id)
    if (!r) return []
    const item = cardRowToItem(r, summary.get(r.id))
    item.bodyType = (r.bodyType as BodyType | null) ?? undefined
    if (r.specs?.manufacturer) item.specs = { manufacturer: r.specs.manufacturer } as VehicleSpecs
    return [item]
  })
}

// Fields the free-text query matches. JSONB columns extract only their string
// leaves ('$.** ? string), so JSON keys / property names ("title"/"value"/lang
// codes) never produce false hits.
const SEARCH_TARGETS = [
  sql.ref('title'),
  sql.ref('location'),
  sql.ref('internal_id'),
  sql`jsonb_path_query_array(description, '$.** ? (@.type() == "string")')`,
  sql`jsonb_path_query_array(highlights, '$.** ? (@.type() == "string")')`,
]

// ---- Pagination ------------------------------------------------------------

type ItemsQuery = SelectQueryBuilder<Database, 'items', object>

interface ItemFilter {
  sold?: boolean
  hidden?: boolean
  type?: 'auction' | 'ad'
  live?: boolean
  categoryId?: string
  ids?: string[]
  q?: string
  // Defaults to the plain text columns; searchPage widens to the JSONB targets.
  searchTargets?: typeof SEARCH_TARGETS
  // Structured facets (search domain). All optional; absent → not applied. Equality on the
  // enum-ish vehicle columns, range on price/registration-year.
  priceMin?: number
  priceMax?: number
  fuelType?: string
  bodyType?: string
  transmission?: string
  driveType?: string
  color?: string
  yearFrom?: number
  yearTo?: number
}

const TEXT_TARGETS = [sql.ref('title'), sql.ref('location'), sql.ref('internal_id')]

const applyItemFilter = (qb: ItemsQuery, f: ItemFilter): ItemsQuery => {
  let b = qb
  if (f.sold !== undefined) b = b.where('sold', '=', f.sold)
  if (f.hidden !== undefined) b = b.where('hidden', '=', f.hidden)
  if (f.type) b = b.where('type', '=', f.type)
  if (f.categoryId) b = b.where('categoryId', '=', f.categoryId)
  if (f.ids) b = b.where('id', 'in', f.ids)
  if (f.live) b = b.where(sql<SqlBool>`start_date < now() and end_date > now()`)
  if (f.priceMin !== undefined) b = b.where('priceFromAmount', '>=', String(f.priceMin))
  if (f.priceMax !== undefined) b = b.where('priceFromAmount', '<=', String(f.priceMax))
  if (f.fuelType) b = b.where('fuelType', '=', f.fuelType)
  if (f.bodyType) b = b.where('bodyType', '=', f.bodyType)
  if (f.transmission) b = b.where('transmission', '=', f.transmission)
  if (f.driveType) b = b.where('driveType', '=', f.driveType)
  if (f.color) b = b.where('color', '=', f.color)
  // first_registration_date is an ISO 'YYYY-MM-DD' string column, so a lexicographic compare
  // against the Jan-1 / Dec-31 year boundaries is a correct inclusive year range.
  if (f.yearFrom !== undefined) b = b.where('firstRegistrationDate', '>=', `${f.yearFrom}-01-01`)
  if (f.yearTo !== undefined) b = b.where('firstRegistrationDate', '<=', `${f.yearTo}-12-31`)
  const q = f.q?.trim()
  if (q) b = b.where(eb => eb.or(unaccentLikeAny(f.searchTargets ?? TEXT_TARGETS, q)))
  return b
}

// statusOrder[itemStatus(item)] mirrored in SQL — keep in sync with defaultSort
// (models/Item.ts). Lower rank sorts first. Evaluated against now() per request.
const STATUS_RANK = sql`
  case
    when sold then 4
    when type = 'ad' then 2
    when end_date is null or start_date is null or end_date < now() then (case when closed then 4 else 1 end)
    when start_date < now() then 1
    else 3
  end`

// Mirror of defaultSort + deterministic tie-breaks (created, id) so paging is stable.
// The end_date tiebreak is LIVE-only: defaultSort sorts just AuctionLive by endDate asc;
// ended-but-unclosed rows (Processing, also STATUS_RANK 1) fall through to visibleUpdated
// desc. Keying it off STATUS_RANK=1 would float their past end_dates above live auctions.
const orderByDefault = (qb: ItemsQuery): ItemsQuery =>
  qb
    .orderBy(sql`(${STATUS_RANK}) asc`)
    .orderBy(sql`(case when start_date < now() and end_date > now() then end_date end) asc nulls last`)
    .orderBy(sql`visible_updated desc nulls last`)
    .orderBy(sql`created desc`)
    .orderBy(sql`id asc`)

const orderByCreated = (qb: ItemsQuery): ItemsQuery => qb.orderBy(sql`created desc`).orderBy(sql`id asc`)

// Terminal items (sold or closed — STATUS_RANK's bottom tier) sort LAST under any explicit search
// sort, so a sold/ended listing never tops a price- or recency-ordered search. Everything still
// active (live auctions, ads, upcoming) is sorted purely by the chosen key — the intuitive meaning
// of "cheapest first". This mirrors how the default 'relevance' order sinks the same tier, without
// imposing its finer auction-vs-ad tiering on an explicit price choice.
const TERMINAL_LAST = sql`(case when (${STATUS_RANK}) = 4 then 1 else 0 end) asc`

// price_from_amount is numeric(20,2) (the pg driver hands it back as a JS string, hence ordering it
// JS-side would be lexical — but the SQL column sorts numerically without a cast). NULL prices sink
// in both directions (nulls last). created/id tie-break keeps paging deterministic for equal prices.
const orderBySearchNewest = (qb: ItemsQuery): ItemsQuery =>
  qb
    .orderBy(TERMINAL_LAST)
    .orderBy(sql`created desc`)
    .orderBy(sql`id asc`)

const orderBySearchPriceAsc = (qb: ItemsQuery): ItemsQuery =>
  qb
    .orderBy(TERMINAL_LAST)
    .orderBy(sql`price_from_amount asc nulls last`)
    .orderBy(sql`created desc`)
    .orderBy(sql`id asc`)

const orderBySearchPriceDesc = (qb: ItemsQuery): ItemsQuery =>
  qb
    .orderBy(TERMINAL_LAST)
    .orderBy(sql`price_from_amount desc nulls last`)
    .orderBy(sql`created desc`)
    .orderBy(sql`id asc`)

const SEARCH_ORDERERS: Record<SearchOrderKey, (qb: ItemsQuery) => ItemsQuery> = {
  newest: orderBySearchNewest,
  priceAsc: orderBySearchPriceAsc,
  priceDesc: orderBySearchPriceDesc,
}

const queryItems = (
  filter: ItemFilter,
  order: (qb: ItemsQuery) => ItemsQuery,
  params: PageParams,
): Promise<Paginated<Item>> =>
  // List payload projects the card columns (no heavy JSONB / vehicle detail) and attaches a bid
  // summary (count + last bid) instead of the full history. paginate counts the full filtered
  // set first, so the projection doesn't affect totals.
  paginate(applyItemFilter(db.selectFrom('items'), filter), order, attachCardData, params, qb =>
    qb.select(CARD_COLUMNS),
  )

export const listItemsPage = (
  filter: { type?: 'auction' | 'ad'; live?: boolean; categoryId?: string },
  params: PageParams,
): Promise<Paginated<Item>> => queryItems({ sold: false, hidden: false, ...filter }, orderByDefault, params)

export const listSoldPage = (params: PageParams): Promise<Paginated<Item>> =>
  queryItems({ sold: true, hidden: false }, orderByCreated, params)

export const listFavoritesPage = (ids: string[], params: PageParams): Promise<Paginated<Item>> =>
  ids.length === 0
    ? Promise.resolve({ items: [], total: 0, page: params.page, pageSize: params.pageSize })
    : queryItems({ hidden: false, ids }, orderByDefault, params)

// Auctions the user has placed at least one bid on — the activity hub's "active bids" view. Shared
// default order (live + ending-soonest first) sorts a contested auction up; hidden rows excluded.
export const listBidItemsPage = (userId: string, params: PageParams): Promise<Paginated<Item>> =>
  paginate(
    applyItemFilter(db.selectFrom('items'), { hidden: false }).where('id', 'in', eb =>
      eb.selectFrom('bids').select('itemId').distinct().where('userId', '=', userId),
    ),
    orderByDefault,
    attachCardData,
    params,
    qb => qb.select(CARD_COLUMNS),
  )

// Auctions the user won (the winner JSONB id matches) — newest-closed first. Powers the hub's "won"
// view, which is otherwise reachable only through the win e-mail.
export const listWonItemsPage = (userId: string, params: PageParams): Promise<Paginated<Item>> =>
  paginate(
    applyItemFilter(db.selectFrom('items'), { sold: true, hidden: false }).where(
      sql<SqlBool>`winner->>'id' = ${userId}`,
    ),
    orderByCreated,
    attachCardData,
    params,
    qb => qb.select(CARD_COLUMNS),
  )

// Faceted fulltext search over visible items. Accepts a structured SearchQuery (q + facets) or a
// bare string (back-compat: a plain term is treated as { q }). The q OR-match widens to the JSONB
// targets; the structured facets layer on as equality/range filters via applyItemFilter. The
// Paginated<Item> response shape is unchanged, so the documented Algolia swap stays a drop-in.
export const searchPage = (
  query: SearchQuery | string,
  params: PageParams,
  sort?: SearchSort,
): Promise<Paginated<Item>> => {
  const sq: SearchQuery = typeof query === 'string' ? { q: query } : query
  // 'relevance' (default, key === null) keeps the shared listing order; the rest pick a dedicated
  // orderer so the chosen sort overrides status rank entirely (the user asked for price/newest).
  const key = searchOrderKey(sort)
  const order = key ? SEARCH_ORDERERS[key] : orderByDefault
  return queryItems(
    {
      hidden: false,
      q: sq.q,
      type: sq.type as 'auction' | 'ad' | undefined,
      categoryId: sq.categoryId,
      priceMin: sq.priceMin,
      priceMax: sq.priceMax,
      fuelType: sq.fuelType,
      bodyType: sq.bodyType,
      transmission: sq.transmission,
      driveType: sq.driveType,
      color: sq.color,
      yearFrom: sq.yearFrom,
      yearTo: sq.yearTo,
      searchTargets: SEARCH_TARGETS,
    },
    order,
    params,
  )
}

// Saved-search alert matches: the newest visible, unsold items matching a stored query, through the
// SAME applyItemFilter + default ordering (live + ending-soonest first) the public search uses — no
// new search engine. The filter forces sold:false + hidden:false (savedSearchQueryToItemFilter), so
// an alert only surfaces buyable listings. searchTargets widens the q match to JSONB like /api/search.
export const listSavedSearchMatchesPage = (
  filter: SavedSearchItemFilter,
  params: PageParams,
): Promise<Paginated<Item>> => queryItems({ ...filter, searchTargets: SEARCH_TARGETS }, orderByDefault, params)

// Lightweight projection for the sitemap: every visible item's id + last-modified
// date, no bids loaded. updated is null on legacy rows, so created (always set) is
// the fallback.
export const listSitemapItems = (): Promise<{ id: string; lastmod: Date }[]> =>
  db
    .selectFrom('items')
    .select(['id', 'updated', 'created'])
    .where('hidden', '=', false)
    .orderBy('updated', 'desc')
    .execute()
    .then(rows => rows.map(r => ({ id: r.id, lastmod: r.updated ?? r.created })))

export const listAdminItemsPage = (
  filter: { q?: string; visibility?: 'visible' | 'hidden' | 'all' },
  params: PageParams,
): Promise<Paginated<Item>> =>
  queryItems(
    {
      hidden: filter.visibility === 'visible' ? false : filter.visibility === 'hidden' ? true : undefined,
      q: filter.q,
    },
    orderByCreated,
    params,
  )

export const listBidsPage = (itemId: string, params: PageParams): Promise<Paginated<Bid>> =>
  paginate(
    db.selectFrom('bids').where('itemId', '=', itemId),
    qb => qb.orderBy('date', 'desc').orderBy('id', 'desc'),
    rows => rows.map(rowToBid),
    params,
  )

export const getById = async (id: string): Promise<Item | undefined> => {
  // Full item incl. the complete bid history — used by the admin editor (in-memory bid pagination)
  // and the create/update return values. The public detail page uses getPublicDetail (slim) instead.
  // Item and its bids are independent lookups keyed on id — fetch concurrently. The published Q&A
  // is no longer embedded: the detail page lazy-fetches /api/item/:id/questions client-side.
  const [row, bids] = await Promise.all([
    db.selectFrom('items').selectAll().where('id', '=', id).executeTakeFirst(),
    db.selectFrom('bids').selectAll().where('itemId', '=', id).orderBy('date', 'asc').execute(),
  ])
  return row ? rowToItem(row, bids) : undefined
}

// Public detail read: every item field but only the LAST bid + the true bidCount (card-style), so a
// long auction's history never bloats the response or the SSR payload. The bid history is loaded
// separately and paginated via /api/item/:id/bids. getById (full bids) backs the admin editor.
export const getPublicDetail = async (id: string): Promise<Item | undefined> => {
  const [row, summary] = await Promise.all([
    db.selectFrom('items').selectAll().where('id', '=', id).executeTakeFirst(),
    loadBidSummary([id]),
  ])
  if (!row) return undefined
  const s = summary.get(id)
  return { ...rowToItem(row), bids: s ? [s.last] : [], bidCount: s?.count ?? 0 }
}

// categoryId and type are DB CHECK columns; an unknown value would otherwise
// surface as an opaque 500. Validate the enum-like input up front and reject it
// as 400. Pure (no DB) so it can be unit-tested. Returns null when input is OK.
const VALID_CATEGORY_IDS = new Set(categories.map(c => c.id))
const VALID_ITEM_TYPES = new Set<string>(Object.values(ItemType))

export const itemInputError = (input: Partial<Item>): { status: number; message: string } | null => {
  if (input.categoryId !== undefined && !VALID_CATEGORY_IDS.has(input.categoryId)) {
    return { status: 400, message: `Unknown categoryId '${input.categoryId}'` }
  }
  if (input.type !== undefined && !VALID_ITEM_TYPES.has(input.type)) {
    return { status: 400, message: `Unknown item type '${input.type}'` }
  }
  // A non-positive minimum increment would let an equal or lower bid clear the
  // "beat current + increment" gate (price could go backwards / a tie resolves arbitrarily).
  if (input.minBid?.amount != null && input.minBid.amount <= 0) {
    return { status: 400, message: 'Minimum bid increment must be positive' }
  }
  if (input.priceFrom?.amount != null && input.priceFrom.amount < 0) {
    return { status: 400, message: 'Asking price must not be negative' }
  }
  if (input.minimalPrice?.amount != null && input.minimalPrice.amount < 0) {
    return { status: 400, message: 'Reserve price must not be negative' }
  }
  return null
}

const assertItemInput = (input: Partial<Item>): void => {
  const err = itemInputError(input)
  if (err) throw createError({ statusCode: err.status, statusMessage: err.message })
}

// Mirrors the old mock create: sensible defaults, body overrides, hidden by default.
export const createItem = async (body: Partial<Item>, fallbackUserId: string): Promise<Item> => {
  assertItemInput(body)
  const now = Date.now()
  // ms + random suffix: second-resolution ids collided on a double-clicked create.
  const id = body.id ?? `i${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const item: Item = {
    images: [],
    images360: [],
    description: {},
    highlights: {},
    bids: [],
    priceHighlighted: false,
    taxIncluded: false,
    sold: false,
    closed: false,
    hidden: true,
    type: ItemType.auction,
    ...body,
    id,
    internalId: body.internalId ?? id.toUpperCase(),
    title: body.title ?? 'Nová položka',
    image: body.image ?? '',
    categoryId: body.categoryId ?? 'others',
    // Ownership is server-controlled: ignore any client userId so a token can't
    // attribute items to another account (and a bad id can't trip the FK as a 500).
    userId: fallbackUserId,
    created: now,
    updated: now,
    visibleUpdated: now,
  }
  await db.insertInto('items').values(itemToInsert(item)).execute()
  const created = (await getById(id))!
  await stampEnrichment(created)
  return created
}

export const updateItem = async (id: string, patch: Partial<Item>): Promise<Item | undefined> => {
  assertItemInput(patch)
  const current = await db.selectFrom('items').select('hidden').where('id', '=', id).executeTakeFirst()
  if (!current) return undefined
  const now = new Date()
  const update: ItemUpdate = { ...itemPatchToUpdate(patch), updated: now }
  // visibleUpdated drives the public "recently updated" sort, so bump it only
  // when visibility actually flips — not on every internal edit of a hidden item.
  const hiddenChanged = 'hidden' in patch && !!patch.hidden !== current.hidden
  if (hiddenChanged) update.visibleUpdated = now
  await db.updateTable('items').set(update).where('id', '=', id).execute()
  const updated = await getById(id)
  if (updated) await stampEnrichment(updated)
  return updated
}

export const removeItem = async (id: string): Promise<void> => {
  await db.deleteFrom('items').where('id', '=', id).execute()
}

// The current top bidder's id (newest bid), or undefined when there are no bids yet. Used by the bid
// endpoint to notify whoever just got outbid — a best-effort read, so a race with a concurrent bid is
// acceptable (worst case: a slightly stale recipient, never a wrong financial outcome).
export const getTopBidderId = async (itemId: string): Promise<string | undefined> => {
  const row = await db
    .selectFrom('bids')
    .select('userId')
    .where('itemId', '=', itemId)
    .orderBy('date', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row?.userId ?? undefined
}

// Place a bid inside a transaction. The item row is locked FOR UPDATE, so
// concurrent bids on the same item serialize and the min-increment check always
// sees the latest committed bid (READ COMMITTED alone would let two bids read
// the same price and both pass). The soft-close rule (a bid in the last 3
// minutes extends the end by 3 minutes) then applies. Throws on a rejected bid.
export const placeBid = async (
  itemId: string,
  userId: string,
  amount: number,
  avatarUrl?: string,
): Promise<Item | undefined> =>
  db.transaction().execute(async trx => {
    const item = await trx.selectFrom('items').selectAll().where('id', '=', itemId).forUpdate().executeTakeFirst()
    if (!item) return undefined
    // Shill-bid guard: the seller must not bid up their own auction (server-authoritative).
    if (item.userId === userId) throw createError({ statusCode: 403, statusMessage: 'Cannot bid on your own item' })

    const now = new Date()
    const nowMs = now.getTime()

    // Current price = latest bid, else the asking price (priceFrom), else 0.
    const last = await trx
      .selectFrom('bids')
      .select('amount')
      .where('itemId', '=', itemId)
      .orderBy('date', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()
    const currentAmount =
      last?.amount != null ? Number(last.amount) : item.priceFromAmount != null ? Number(item.priceFromAmount) : 0
    // Clamp to ≥1 so a mis-set (0 / negative / NaN) minBid can't let an equal or lower bid win.
    const increment = Math.max(1, item.minBidAmount != null ? Number(item.minBidAmount) : 1)

    const err = bidError({
      type: item.type,
      sold: item.sold,
      hidden: item.hidden,
      closed: item.closed,
      startMs: item.startDate ? item.startDate.getTime() : null,
      endMs: item.endDate ? item.endDate.getTime() : null,
      currentAmount,
      increment,
      amount,
      nowMs,
    })
    if (err) throw createError({ statusCode: err.status, statusMessage: err.message })

    await trx
      .insertInto('bids')
      .values({
        itemId,
        userId,
        amount,
        currencyCode: item.priceFromCurrency,
        date: now,
        avatarUrl: avatarUrl ?? null,
      })
      .execute()

    const update: ItemUpdate = { visibleUpdated: now }
    const endMs = item.endDate ? item.endDate.getTime() : null
    const newEnd = softCloseEnd(endMs, nowMs)
    if (newEnd !== endMs) update.endDate = new Date(newEnd!)
    await trx.updateTable('items').set(update).where('id', '=', itemId).execute()

    // Return the slim public shape (last bid + true count), not the full ordered history — the
    // client refreshes the paginated bid list separately. Keeps the FOR UPDATE critical section
    // O(1) instead of O(bids) exactly when contention is highest. count(*) over () is evaluated
    // before LIMIT, so one row carries both the newest bid and the total.
    const updated = await trx.selectFrom('items').selectAll().where('id', '=', itemId).executeTakeFirst()
    const lastRow = await trx
      .selectFrom('bids')
      .selectAll()
      .select(sql<string>`count(*) over ()`.as('bidCount'))
      .where('itemId', '=', itemId)
      .orderBy('date', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()
    return {
      ...rowToItem(updated!),
      bids: lastRow ? [rowToBid(lastRow)] : [],
      bidCount: lastRow ? Number(lastRow.bidCount) : 0,
    }
  })

// ---- Closing ended auctions (close-auctions cron job) ----------------------

// Auctions past their end that still need finalizing. Bounded batch (oldest first);
// any overflow is picked up by the next run. Hidden auctions are skipped — an admin
// pulled them, so they shouldn't auto-close or e-mail.
export const listClosableAuctionIds = (limit: number): Promise<string[]> =>
  db
    .selectFrom('items')
    .select('id')
    .where('type', '=', 'auction')
    .where('closed', '=', false)
    .where('hidden', '=', false)
    .where('endDate', 'is not', null)
    .where(sql<SqlBool>`end_date < now()`)
    .orderBy('endDate', 'asc')
    .limit(limit)
    .execute()
    .then(rows => rows.map(r => r.id))

// Finalize one auction inside a transaction. The row is locked FOR UPDATE so it
// serializes with placeBid, then the end is re-checked under the lock: a late
// soft-close bid may have pushed the end out, or a concurrent run may have closed
// it, after listClosableAuctionIds read it. Returns the outcome, or null when the
// row was skipped (gone / already closed / not actually ended). E-mail is the
// caller's job (separate idempotent sweep), so this stays pure data access.
export const closeOneAuction = (itemId: string): Promise<{ sold: boolean } | null> =>
  db.transaction().execute(async trx => {
    const item = await trx
      .selectFrom('items')
      .select(['id', 'type', 'closed', 'endDate', 'minimalPriceAmount'])
      .where('id', '=', itemId)
      .forUpdate()
      .executeTakeFirst()
    if (!item) return null

    const endMs = item.endDate ? item.endDate.getTime() : null
    if (item.closed || item.type !== 'auction' || endMs == null || endMs >= Date.now()) return null

    const highest = await trx
      .selectFrom('bids')
      .select(['userId', 'amount'])
      .where('itemId', '=', itemId)
      .orderBy('date', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()
    const highestBid = highest?.amount != null ? { userId: highest.userId, amount: Number(highest.amount) } : null
    const reserve = item.minimalPriceAmount != null ? Number(item.minimalPriceAmount) : null
    const outcome = decideAuctionOutcome(highestBid, reserve)

    const now = new Date()
    const update: ItemUpdate = { closed: true, sold: outcome.sold, updated: now, visibleUpdated: now }
    if (outcome.sold && outcome.winnerUserId) {
      const u = await trx
        .selectFrom('users')
        .select('fullName')
        .where('id', '=', outcome.winnerUserId)
        .executeTakeFirst()
      update.winner = { id: outcome.winnerUserId, name: u?.fullName ?? '' }
    }
    await trx.updateTable('items').set(update).where('id', '=', itemId).execute()
    return { sold: outcome.sold }
  })

// Sold auctions whose winner e-mail hasn't been enqueued yet. Drives the idempotent
// e-mail sweep: it naturally re-includes anything a prior run closed but crashed
// before mailing. winner->>'id' is the recipient (the JSONB winner is {id, name}).
export const listWinnersPendingEmail = (
  limit: number,
): Promise<{ itemId: string; winnerUserId: string; title: string }[]> =>
  db
    .selectFrom('items')
    .select(['id', 'title', sql<string>`winner->>'id'`.as('winnerUserId')])
    .where('sold', '=', true)
    .where('winner', 'is not', null)
    .where('winnerEmailedAt', 'is', null)
    .orderBy('endDate', 'asc')
    .limit(limit)
    .execute()
    .then(rows => rows.map(r => ({ itemId: r.id, winnerUserId: r.winnerUserId, title: r.title })))

// Stamp the winner e-mail as enqueued. The null guard keeps it a no-op if a
// concurrent run already claimed it, so two overlapping runs can't double-mark.
export const markWinnerEmailed = async (itemId: string): Promise<void> => {
  await db
    .updateTable('items')
    .set({ winnerEmailedAt: new Date() })
    .where('id', '=', itemId)
    .where('winnerEmailedAt', 'is', null)
    .execute()
}
