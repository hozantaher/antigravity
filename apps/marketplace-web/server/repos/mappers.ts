import type {
  ApiTokenRow,
  Bid,
  BodyType,
  ContactMessage,
  ContactStatus,
  Currency,
  DriveType,
  FuelType,
  Invoice,
  Item,
  Language,
  LiveItem,
  NewQuestion,
  Price,
  Question,
  QuestionStatus,
  SavedSearch,
  SearchQuery,
  Settlement,
  Transmission,
  User,
  UserRole,
  VehicleColor,
} from '~/models'
// Relative (not ~) so tsx-run scripts (seed:dev, grant:admin) can resolve the enum/helper values.
import {
  AuthType,
  DEPOSIT_INVOICE_TYPE,
  ItemType,
  SALE_INVOICE_TYPE,
  computeAmountDue,
  depositCreditApplied,
  isValidSavedSearchName,
  normalizeSavedSearchQuery,
  settlementStateFrom,
} from '../../models'
import { currencies, languages, EUR } from '../data/fixtures'
import type {
  BidInsert,
  BidRow,
  ContactMessageRow,
  InvoiceInsert,
  InvoiceRow,
  ItemInsert,
  ItemRow,
  ItemUpdate,
  QuestionInsert,
  QuestionRow,
  SavedSearchInsert,
  SavedSearchRow,
  SavedSearchUpdate,
  UserInsert,
  UserRow,
  UserUpdate,
} from '../db/schema'

// ---- Reference rehydration (codes → full objects the frontend expects) -----

export const currencyByCode = (code: string | null | undefined): Currency | undefined =>
  code ? currencies.find(c => c.code === code) : undefined

export const languageByCode = (code: string | null | undefined): Language =>
  (code ? languages.find(l => l.code === code) : undefined) ?? languages[0]!

const toPrice = (amount: string | null, code: string | null): Price | undefined =>
  amount == null ? undefined : { amount: Number(amount), currency: currencyByCode(code) }

const toMs = (d: Date | null): number | undefined => (d ? d.getTime() : undefined)

// DB stores the Firebase provider string; the User model uses a numeric enum.
const authTypeToString = (t: AuthType): 'email' | 'facebook' | 'google' =>
  t === AuthType.facebook ? 'facebook' : t === AuthType.google ? 'google' : 'email'

const authTypeFromString = (s: string): AuthType =>
  s === 'facebook' ? AuthType.facebook : s === 'google' ? AuthType.google : AuthType.email

// DB stores the item kind as a string; the Item model uses a numeric enum.
const itemTypeToString = (t: ItemType): 'auction' | 'ad' => (t === ItemType.ad ? 'ad' : 'auction')

export const itemTypeFromString = (s: string): ItemType => (s === 'ad' ? ItemType.ad : ItemType.auction)

// ---- Row → model -----------------------------------------------------------

export const rowToBid = (row: BidRow): Bid => ({
  userId: row.userId,
  date: row.date.getTime(),
  amount: row.amount == null ? undefined : Number(row.amount),
  currency: currencyByCode(row.currencyCode),
  avatarUrl: row.avatarUrl ?? undefined,
})

export const rowToQuestion = (row: QuestionRow): Question => ({
  id: row.id,
  itemId: row.itemId,
  userId: row.userId,
  body: row.body,
  answer: row.answer ?? undefined,
  answeredBy: row.answeredBy ?? undefined,
  status: row.status as QuestionStatus,
  created: row.created.getTime(),
  answeredAt: toMs(row.answeredAt),
})

export const rowToItem = (row: ItemRow, bids: BidRow[] = []): Item => ({
  id: row.id,
  internalId: row.internalId ?? undefined,
  title: row.title,
  image: row.image,
  images: row.images,
  images360: row.images360,
  description: row.description ?? {},
  highlights: row.highlights ?? {},
  minimalPrice: toPrice(row.minimalPriceAmount, row.minimalPriceCurrency),
  priceFrom: toPrice(row.priceFromAmount, row.priceFromCurrency),
  minBid: toPrice(row.minBidAmount, row.minBidCurrency),
  categoryId: row.categoryId,
  userId: row.userId,
  bids: bids.map(rowToBid),
  location: row.location ?? undefined,
  countryCode: row.countryCode ?? undefined,
  youtubeVideoId: row.youtubeVideoId ?? undefined,
  priceHighlighted: row.priceHighlighted,
  taxIncluded: row.taxIncluded,
  sold: row.sold,
  closed: row.closed,
  hidden: row.hidden,
  winner: row.winner ?? undefined,
  email: row.email ?? undefined,
  phone: row.phone ?? undefined,
  startDate: toMs(row.startDate),
  endDate: toMs(row.endDate),
  type: itemTypeFromString(row.type),
  created: toMs(row.created),
  updated: toMs(row.updated),
  visibleUpdated: toMs(row.visibleUpdated),
  gps: row.gps ?? undefined,
  vin: row.vin ?? undefined,
  fuelType: (row.fuelType as FuelType | null) ?? undefined,
  transmission: (row.transmission as Transmission | null) ?? undefined,
  bodyType: (row.bodyType as BodyType | null) ?? undefined,
  driveType: (row.driveType as DriveType | null) ?? undefined,
  enginePowerKw: row.enginePowerKw ?? undefined,
  engineDisplacementCcm: row.engineDisplacementCcm ?? undefined,
  color: (row.color as VehicleColor | null) ?? undefined,
  firstRegistrationDate: row.firstRegistrationDate ?? undefined,
  specs: row.specs ?? undefined,
})

// Columns a grid card actually needs. Deliberately omits the heavy ones — description,
// highlights, specs, winner, vehicle detail — so list queries don't stream them.
// Keep in sync with cardRowToItem.
export const CARD_COLUMNS = [
  'id',
  'internalId',
  'title',
  'image',
  'minimalPriceAmount',
  'minimalPriceCurrency',
  'priceFromAmount',
  'priceFromCurrency',
  'minBidAmount',
  'minBidCurrency',
  'categoryId',
  'userId',
  'location',
  'countryCode',
  'priceHighlighted',
  'taxIncluded',
  'sold',
  'closed',
  'hidden',
  'startDate',
  'endDate',
  'type',
  'created',
  'updated',
  'visibleUpdated',
] as const

export type CardItemRow = Pick<ItemRow, (typeof CARD_COLUMNS)[number]>

export interface BidSummary {
  count: number
  last: Bid
}

// Row → Item for list/card views: heavy fields are blanked (the query never selected them) and
// bids carries only the last bid, with the true total in bidCount. The detail path uses the
// full rowToItem instead. images/images360 are NOT selected — cards render only `image` (the
// single cover), so shipping the full gallery arrays was dead payload on every list page.
export const cardRowToItem = (row: CardItemRow, summary?: BidSummary): Item => ({
  id: row.id,
  internalId: row.internalId ?? undefined,
  title: row.title,
  image: row.image,
  images: [],
  images360: [],
  description: {},
  highlights: {},
  minimalPrice: toPrice(row.minimalPriceAmount, row.minimalPriceCurrency),
  priceFrom: toPrice(row.priceFromAmount, row.priceFromCurrency),
  minBid: toPrice(row.minBidAmount, row.minBidCurrency),
  categoryId: row.categoryId,
  userId: row.userId,
  bids: summary ? [summary.last] : [],
  bidCount: summary?.count ?? 0,
  location: row.location ?? undefined,
  countryCode: row.countryCode ?? undefined,
  priceHighlighted: row.priceHighlighted,
  taxIncluded: row.taxIncluded,
  sold: row.sold,
  closed: row.closed,
  hidden: row.hidden,
  startDate: toMs(row.startDate),
  endDate: toMs(row.endDate),
  type: itemTypeFromString(row.type),
  created: toMs(row.created),
  updated: toMs(row.updated),
  visibleUpdated: toMs(row.visibleUpdated),
})

export type LiveItemRow = Pick<ItemRow, 'id' | 'endDate' | 'sold' | 'closed' | 'winner'>

// Row (+ bid summary) → the slim live state the FE polls. Same FE contract as the card mapper:
// epoch-ms end, the last bid as a Price-bearing Bid, bidCount as the true total. Pure.
export const toLiveItem = (row: LiveItemRow, summary?: BidSummary): LiveItem => ({
  id: row.id,
  lastBid: summary?.last,
  bidCount: summary?.count ?? 0,
  endDate: toMs(row.endDate),
  sold: row.sold,
  closed: row.closed,
  winner: row.winner ?? undefined,
})

export const rowToUser = (row: UserRow): User => ({
  id: row.id,
  authType: authTypeFromString(row.authType),
  fullName: row.fullName,
  email: row.email,
  companyName: row.companyName ?? undefined,
  companyVatNumber: row.companyVatNumber ?? undefined,
  companyIdNumber: row.companyIdNumber ?? undefined,
  bankAccount: row.bankAccount ?? undefined,
  phone: row.phone ?? undefined,
  address: row.address ?? undefined,
  vat: row.vat == null ? undefined : Number(row.vat),
  roles: row.roles as UserRole[],
  depositBalance: {
    amount: row.depositBalanceAmount == null ? 0 : Number(row.depositBalanceAmount),
    currency: currencyByCode(row.depositBalanceCurrency) ?? EUR,
  },
  fakturoidId: row.fakturoidId ?? undefined,
  invoiceDueDays: row.invoiceDueDays,
  favoriteIds: row.favoriteIds,
  language: languageByCode(row.languageCode),
  newsletter: row.newsletter,
  depositRequired: row.depositRequired,
  emailVerified: row.emailVerified,
})

export const rowToInvoice = (row: InvoiceRow): Invoice => ({
  id: row.id,
  userId: row.userId,
  createdDate: toMs(row.createdDate),
  invoiceCreatedDate: toMs(row.invoiceCreatedDate),
  invoiceDueDate: toMs(row.invoiceDueDate),
  paidAt: toMs(row.paidAt),
  status: row.status,
  price: toPrice(row.priceAmount, row.priceCurrency),
  url: row.url ?? undefined,
  // 'deposit' | 'sale' — surfaced so a reader can distinguish a deposit proforma from a sale invoice
  // (the DB column is a free string, narrowed to the two known kinds).
  type: row.type === SALE_INVOICE_TYPE ? SALE_INVOICE_TYPE : DEPOSIT_INVOICE_TYPE,
})

// Item (+ its sale invoice, if any) + the winning bid + the winner's deposit balance → the
// winner-facing Settlement projection. Pure: amounts → Number, currency rehydrated via
// currencyByCode, settlement state derived from invoice.status × the settled_at marker. The final
// price is the winning bid's amount in its currency; the deposit credit is offset only when its
// currency matches the auction currency (computeAmountDue's cross-currency guard).
export const rowToSettlement = (
  item: Pick<ItemRow, 'id' | 'settledAt'>,
  invoice: InvoiceRow | undefined,
  finalBid: Pick<BidRow, 'amount' | 'currencyCode'> | undefined,
  depositBalance: { amount: number; currency: string | null } | undefined,
): Settlement => {
  const finalPrice: Price = {
    amount: finalBid?.amount == null ? 0 : Number(finalBid.amount),
    currency: currencyByCode(finalBid?.currencyCode),
  }
  const depositHeld: Price | undefined = depositBalance
    ? { amount: depositBalance.amount, currency: currencyByCode(depositBalance.currency) }
    : undefined

  const amountDue = computeAmountDue(finalPrice, depositHeld)
  const depositCredit = depositCreditApplied(finalPrice, depositHeld)
  const state = settlementStateFrom(invoice?.status, item.settledAt != null)

  return {
    itemId: item.id,
    invoiceId: invoice?.id ?? null,
    finalPrice,
    depositCredit,
    amountDue,
    state,
  }
}

export const rowToContactMessage = (row: ContactMessageRow): ContactMessage => ({
  id: row.id,
  kind: row.kind,
  name: row.name ?? undefined,
  email: row.email ?? undefined,
  phone: row.phone ?? undefined,
  location: row.location ?? undefined,
  vehicle: row.vehicle ?? undefined,
  message: row.message ?? undefined,
  itemId: row.itemId ?? undefined,
  userId: row.userId ?? undefined,
  offer: toPrice(row.offerAmount, row.offerCurrency),
  status: row.status as ContactStatus,
  notifiedAt: toMs(row.notifiedAt),
  created: row.created.getTime(),
})

// The list/detail query left-joins users for the creator's name, so the row shape
// is wider than a plain Selectable<ApiTokensTable>.
export interface ApiTokenJoinRow {
  id: string
  name: string
  tokenPrefix: string
  createdBy: string
  createdByName: string | null
  createdAt: Date
  lastUsedAt: Date | null
}

export const apiTokenRowToModel = (row: ApiTokenJoinRow): ApiTokenRow => ({
  id: row.id,
  name: row.name,
  tokenPrefix: row.tokenPrefix,
  createdBy: row.createdBy,
  createdByName: row.createdByName ?? null,
  createdAt: row.createdAt.getTime(),
  lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
})

// Row → SavedSearch. Dates as epoch-ms (FE contract); the stored jsonb query is re-normalized so a
// hand-edited/legacy row can't surface a dirty query. last_alerted_at is deliberately not mapped
// (server-only CAS column).
export const rowToSavedSearch = (row: SavedSearchRow): SavedSearch => ({
  id: row.id,
  userId: row.userId,
  name: row.name,
  query: normalizeSavedSearchQuery(row.query),
  alertEnabled: row.alertEnabled,
  createdAt: row.createdAt.getTime(),
  updatedAt: toMs(row.updatedAt),
})

// ---- model → insert (seeding + create) -------------------------------------

export const userToInsert = (u: User): UserInsert => ({
  id: u.id,
  authType: authTypeToString(u.authType),
  fullName: u.fullName,
  email: u.email,
  companyName: u.companyName ?? null,
  companyVatNumber: u.companyVatNumber ?? null,
  companyIdNumber: u.companyIdNumber ?? null,
  bankAccount: u.bankAccount ?? null,
  phone: u.phone ?? null,
  address: u.address ?? null,
  vat: u.vat ?? null,
  roles: u.roles,
  depositBalanceAmount: u.depositBalance?.amount ?? null,
  depositBalanceCurrency: u.depositBalance?.currency?.code ?? null,
  invoiceDueDays: u.invoiceDueDays,
  favoriteIds: u.favoriteIds,
  languageCode: u.language?.code ?? null,
  newsletter: u.newsletter,
  emailVerified: u.emailVerified ?? false,
  depositRequired: u.depositRequired ?? true,
  fakturoidId: u.fakturoidId ?? null,
})

export const itemToInsert = (it: Item): ItemInsert => ({
  id: it.id,
  internalId: it.internalId ?? null,
  title: it.title,
  image: it.image ?? '',
  images: it.images ?? [],
  images360: it.images360 ?? [],
  description: it.description ?? null,
  highlights: it.highlights ?? null,
  minimalPriceAmount: it.minimalPrice?.amount ?? null,
  minimalPriceCurrency: it.minimalPrice?.currency?.code ?? null,
  priceFromAmount: it.priceFrom?.amount ?? null,
  priceFromCurrency: it.priceFrom?.currency?.code ?? null,
  minBidAmount: it.minBid?.amount ?? null,
  minBidCurrency: it.minBid?.currency?.code ?? null,
  categoryId: it.categoryId,
  userId: it.userId,
  location: it.location ?? null,
  countryCode: it.countryCode ?? null,
  youtubeVideoId: it.youtubeVideoId ?? null,
  priceHighlighted: it.priceHighlighted,
  taxIncluded: it.taxIncluded,
  sold: it.sold,
  closed: it.closed,
  hidden: it.hidden,
  winner: it.winner ?? null,
  email: it.email ?? null,
  phone: it.phone ?? null,
  startDate: it.startDate ? new Date(it.startDate) : null,
  endDate: it.endDate ? new Date(it.endDate) : null,
  type: itemTypeToString(it.type),
  created: it.created ? new Date(it.created) : new Date(),
  updated: it.updated ? new Date(it.updated) : null,
  visibleUpdated: it.visibleUpdated ? new Date(it.visibleUpdated) : null,
  gps: it.gps ?? null,
  vin: it.vin ?? null,
  fuelType: it.fuelType ?? null,
  transmission: it.transmission ?? null,
  bodyType: it.bodyType ?? null,
  driveType: it.driveType ?? null,
  enginePowerKw: it.enginePowerKw ?? null,
  engineDisplacementCcm: it.engineDisplacementCcm ?? null,
  color: it.color ?? null,
  firstRegistrationDate: it.firstRegistrationDate ?? null,
  specs: it.specs ?? null,
})

export const bidToInsert = (itemId: string, b: Bid): BidInsert => ({
  itemId,
  userId: b.userId,
  amount: b.amount ?? null,
  currencyCode: b.currency?.code ?? null,
  date: new Date(b.date),
  avatarUrl: b.avatarUrl ?? null,
})

export const questionToInsert = (q: NewQuestion): QuestionInsert => ({
  itemId: q.itemId,
  userId: q.userId,
  body: q.body,
})

export const invoiceToInsert = (inv: Invoice): InvoiceInsert => ({
  id: inv.id,
  userId: inv.userId,
  createdDate: inv.createdDate ? new Date(inv.createdDate) : null,
  invoiceCreatedDate: inv.invoiceCreatedDate ? new Date(inv.invoiceCreatedDate) : null,
  invoiceDueDate: inv.invoiceDueDate ? new Date(inv.invoiceDueDate) : null,
  paidAt: inv.paidAt ? new Date(inv.paidAt) : null,
  status: inv.status,
  priceAmount: inv.price?.amount ?? null,
  priceCurrency: inv.price?.currency?.code ?? null,
  url: inv.url ?? null,
})

// The accepted create body for a saved search: the user-chosen name, the SearchQuery to persist,
// and an optional initial alert flag. userId/id/timestamps are server-controlled, never from the body.
export interface SavedSearchCreateBody {
  name: string
  query?: SearchQuery
  alertEnabled?: boolean
}

// Create body → insert row. The id + userId are server-supplied (never trusted from the body); the
// query is normalized so a crafted body can't store a dirty filter. name is trimmed.
export const savedSearchCreateToInsert = (
  id: string,
  userId: string,
  body: SavedSearchCreateBody,
): SavedSearchInsert => ({
  id,
  userId,
  name: body.name.trim(),
  query: normalizeSavedSearchQuery(body.query),
  alertEnabled: body.alertEnabled ?? true,
})

// Self-service saved-search patch → column update. Whitelist: only `name` + `alertEnabled` are
// mutable (mirrors userProfilePatchToUpdate). id/userId/query/createdAt/lastAlertedAt are
// intentionally excluded so a crafted PATCH body can't reassign ownership, rewrite the stored query,
// or clear the alert CAS stamp. updatedAt is stamped by the repo. Only present, valid keys are mapped.
export const savedSearchPatchToUpdate = (p: { name?: unknown; alertEnabled?: unknown }): SavedSearchUpdate => {
  const u: SavedSearchUpdate = {}
  if ('name' in p && isValidSavedSearchName(p.name)) u.name = p.name.trim()
  if ('alertEnabled' in p && typeof p.alertEnabled === 'boolean') u.alertEnabled = p.alertEnabled
  return u
}

// Partial patch → column update. Only maps keys present on the patch so a
// `{ hidden }` toggle doesn't null out everything else. updated/visibleUpdated
// are stamped by the repo, not here.
export const itemPatchToUpdate = (p: Partial<Item>): ItemUpdate => {
  const u: ItemUpdate = {}
  if ('internalId' in p) u.internalId = p.internalId ?? null
  if ('title' in p) u.title = p.title!
  if ('image' in p) u.image = p.image ?? ''
  if ('images' in p) u.images = p.images ?? []
  if ('images360' in p) u.images360 = p.images360 ?? []
  if ('description' in p) u.description = p.description ?? null
  if ('highlights' in p) u.highlights = p.highlights ?? null
  if ('minimalPrice' in p) {
    u.minimalPriceAmount = p.minimalPrice?.amount ?? null
    u.minimalPriceCurrency = p.minimalPrice?.currency?.code ?? null
  }
  if ('priceFrom' in p) {
    u.priceFromAmount = p.priceFrom?.amount ?? null
    u.priceFromCurrency = p.priceFrom?.currency?.code ?? null
  }
  if ('minBid' in p) {
    u.minBidAmount = p.minBid?.amount ?? null
    u.minBidCurrency = p.minBid?.currency?.code ?? null
  }
  if ('categoryId' in p) u.categoryId = p.categoryId!
  // userId (ownership) is server-controlled, not patchable: a crafted PUT body
  // must not reassign an item to another account or trip the FK as a 500.
  if ('location' in p) u.location = p.location ?? null
  if ('countryCode' in p) u.countryCode = p.countryCode ?? null
  if ('youtubeVideoId' in p) u.youtubeVideoId = p.youtubeVideoId ?? null
  if ('priceHighlighted' in p) u.priceHighlighted = p.priceHighlighted!
  if ('taxIncluded' in p) u.taxIncluded = p.taxIncluded!
  if ('sold' in p) u.sold = p.sold!
  if ('closed' in p) u.closed = p.closed!
  if ('hidden' in p) u.hidden = p.hidden!
  if ('winner' in p) u.winner = p.winner ?? null
  if ('email' in p) u.email = p.email ?? null
  if ('phone' in p) u.phone = p.phone ?? null
  if ('startDate' in p) u.startDate = p.startDate ? new Date(p.startDate) : null
  if ('endDate' in p) u.endDate = p.endDate ? new Date(p.endDate) : null
  if ('type' in p) u.type = itemTypeToString(p.type!)
  if ('gps' in p) u.gps = p.gps ?? null
  if ('vin' in p) u.vin = p.vin ?? null
  if ('fuelType' in p) u.fuelType = p.fuelType ?? null
  if ('transmission' in p) u.transmission = p.transmission ?? null
  if ('bodyType' in p) u.bodyType = p.bodyType ?? null
  if ('driveType' in p) u.driveType = p.driveType ?? null
  if ('enginePowerKw' in p) u.enginePowerKw = p.enginePowerKw ?? null
  if ('engineDisplacementCcm' in p) u.engineDisplacementCcm = p.engineDisplacementCcm ?? null
  if ('color' in p) u.color = p.color ?? null
  if ('firstRegistrationDate' in p) u.firstRegistrationDate = p.firstRegistrationDate ?? null
  if ('specs' in p) u.specs = p.specs ?? null
  return u
}

// Self-service profile patch → column update. Whitelist: only fields a user may
// edit about themselves. Auth-owned (email/emailVerified), money (deposit/vat),
// authorization (roles/banned) and favorites are intentionally excluded so a
// crafted PUT body can't escalate.
export const userProfilePatchToUpdate = (p: Partial<User>): UserUpdate => {
  const u: UserUpdate = {}
  if ('fullName' in p) u.fullName = p.fullName!
  if ('phone' in p) u.phone = p.phone ?? null
  if ('companyName' in p) u.companyName = p.companyName ?? null
  if ('companyVatNumber' in p) u.companyVatNumber = p.companyVatNumber ?? null
  if ('companyIdNumber' in p) u.companyIdNumber = p.companyIdNumber ?? null
  if ('bankAccount' in p) u.bankAccount = p.bankAccount ?? null
  if ('address' in p) {
    // address is a JSONB object column; a non-object (array/string) would serialize as a PG array
    // literal / fail the jsonb cast → 500. Accept a plain object (or null to clear) only.
    const a = p.address
    u.address = a && typeof a === 'object' && !Array.isArray(a) ? a : null
  }
  if ('newsletter' in p) u.newsletter = p.newsletter!
  if ('language' in p) u.languageCode = p.language?.code ?? null
  return u
}
