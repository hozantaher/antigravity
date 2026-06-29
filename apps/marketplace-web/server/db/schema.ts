import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely'
import type {
  Address,
  AdHighlight,
  Gps,
  ItemVector,
  NormalizedVin,
  PopularityRankingEntry,
  SearchQuery,
  TrackEventMeta,
  VehicleSpecs,
  VincarioDecodeResponse,
  VisitorFeatureVector,
  Winner,
} from '~/models'

// camelCase here → snake_case columns via CamelCasePlugin in db.ts.

// pg returns numeric(20,2) as a string; accept number|string on write.
type Numeric = ColumnType<string, number | string, number | string>
// timestamptz: pg returns a Date; accept Date|string on write.
type Timestamp = ColumnType<Date, Date | string, Date | string>

export interface UsersTable {
  id: string
  authType: 'email' | 'facebook' | 'google'
  fullName: string
  email: string
  companyName: string | null
  companyVatNumber: string | null
  companyIdNumber: string | null
  bankAccount: string | null
  phone: string | null
  address: Address | null
  vat: Numeric | null
  roles: Generated<string[]>
  depositBalanceAmount: Numeric | null
  depositBalanceCurrency: string | null
  invoiceDueDays: Generated<number>
  favoriteIds: Generated<string[]>
  languageCode: string | null
  newsletter: Generated<boolean>
  // Last newsletter send (§12 cadence gate). Server-only — never mapped into the User model.
  newsletterLastSentAt: Timestamp | null
  emailVerified: Generated<boolean>
  depositRequired: Generated<boolean>
  // Unique 10-digit variable symbol the user pays the deposit with (PG default generate_deposit_vs()).
  depositVs: Generated<string>
  fakturoidId: number | null
  banned: Generated<boolean>
  // Revocation cutoff: getSessionUser rejects tokens whose iat <= this. Default 'epoch'.
  tokensValidAfter: Generated<Date>
  created: Generated<Date>
  // Soft-delete marker (account deletion); getSessionUser rejects deleted rows.
  deletedAt: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
}

export interface ItemsTable {
  id: string
  internalId: string | null
  title: string
  image: string
  images: Generated<string[]>
  images360: Generated<string[]>
  description: Record<string, string> | null
  highlights: Record<string, AdHighlight[]> | null
  minimalPriceAmount: Numeric | null
  minimalPriceCurrency: string | null
  priceFromAmount: Numeric | null
  priceFromCurrency: string | null
  minBidAmount: Numeric | null
  minBidCurrency: string | null
  categoryId: string
  userId: string
  location: string | null
  countryCode: string | null
  youtubeVideoId: string | null
  priceHighlighted: Generated<boolean>
  taxIncluded: Generated<boolean>
  sold: Generated<boolean>
  closed: Generated<boolean>
  hidden: Generated<boolean>
  winner: Winner | null
  // Set when the close-auctions job has enqueued the winner e-mail; null = not yet sent.
  winnerEmailedAt: Timestamp | null
  // Sale-settlement (migration 025). settledAt = the "sale completed" stamp (set once under a
  // WHERE settled_at IS NULL CAS); settlementInvoiceId = item → its type='sale' invoice (partial
  // unique → at most one live sale invoice per item).
  settledAt: Timestamp | null
  settlementInvoiceId: string | null
  email: string | null
  phone: string | null
  startDate: Timestamp | null
  endDate: Timestamp | null
  type: 'auction' | 'ad'
  created: Generated<Date>
  updated: Timestamp | null
  visibleUpdated: Timestamp | null
  gps: Gps | null
  vin: string | null
  fuelType: string | null
  transmission: string | null
  bodyType: string | null
  driveType: string | null
  enginePowerKw: number | null
  engineDisplacementCcm: number | null
  color: string | null
  firstRegistrationDate: string | null
  specs: VehicleSpecs | null
  // Deterministic enrichment sweep (migration 035). 'pending' is stamped by create/updateItem when
  // a VIN is set but specs empty, or a description exists but a DeepL locale is empty; the cron
  // claim-CAS flips it 'processing' → 'ready'/'failed'. Server-only — never mapped into the Item model.
  enrichmentStatus: Generated<string>
  enrichmentClaimedAt: Timestamp | null
  enrichmentAttempts: Generated<number>
  enrichmentError: string | null
}

export interface BidsTable {
  id: Generated<string>
  itemId: string
  userId: string
  amount: Numeric | null
  currencyCode: string | null
  date: Timestamp
  avatarUrl: string | null
}

// Public Q&A on a listing. item_id cascades with the item; user_id (asker) restricts. answered_by
// is a soft ref (no FK). Moderated: status defaults to 'pending' (hidden) until an admin publishes.
export interface ItemQuestionsTable {
  id: Generated<string>
  itemId: string
  userId: string
  body: string
  answer: string | null
  answeredBy: string | null
  status: Generated<string>
  created: Generated<Date>
  answeredAt: Timestamp | null
}

// A buyer's rating of a seller, gated by a settled sale. invoice_id is UNIQUE (one paid sale → at
// most one rating). item_id cascades with the item; seller_id/rater_id restrict (the parties survive).
export interface ItemRatingsTable {
  id: Generated<string>
  itemId: string
  sellerId: string
  raterId: string
  invoiceId: string
  score: number
  comment: string | null
  // Moderation status: 'visible' (default) | 'hidden'. Hidden ratings drop out of seller reputation.
  status: Generated<string>
  created: Generated<Date>
}

// A buyer's complaint against a settled sale, moved open → review → resolved by ops. invoice_id is
// UNIQUE (one settled sale → one case). resolved_at/resolution/resolved_by carry the documented ops
// decision.
export interface DisputesTable {
  id: Generated<string>
  itemId: string
  invoiceId: string
  openerId: string
  reason: string
  status: Generated<string>
  resolution: string | null
  resolvedBy: string | null
  resolvedAt: Timestamp | null
  created: Generated<Date>
}

// In-app notifications for key user events (win / outbid / answer). dedupe_key is UNIQUE so re-raising
// the same event collapses to one row. read_at null = unread.
export interface NotificationsTable {
  id: Generated<string>
  userId: string
  type: string
  itemId: string | null
  title: string
  dedupeKey: string
  readAt: Timestamp | null
  created: Generated<Date>
}

// Per-run history of scheduled jobs (crons) — powers the /admin/ops health view. `counts` holds the
// job's result struct; `ok=false` + `error` on failure. Written best-effort by withJobRun.
export interface JobRunsTable {
  id: Generated<string>
  job: string
  startedAt: Generated<Date>
  finishedAt: Timestamp | null
  ok: boolean | null
  counts: Record<string, unknown> | null
  error: string | null
}

// Append-only trail of sensitive/irreversible admin actions (delete, ban, grant-admin, hide).
// before/after capture the change; actorId is the admin who did it. Written best-effort.
export interface AuditLogTable {
  id: Generated<string>
  actorId: string | null
  action: string
  entity: string
  entityId: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  at: Generated<Date>
  ip: string | null
}

export interface InvoicesTable {
  id: string
  userId: string
  createdDate: Timestamp | null
  invoiceCreatedDate: Timestamp | null
  invoiceDueDate: Timestamp | null
  paidAt: Timestamp | null
  status: string
  priceAmount: Numeric | null
  priceCurrency: string | null
  url: string | null
  fakturoidId: number | null
  variableSymbol: string | null
  iban: string | null
  // Payer's billing address, snapshotted from users.address when the sale invoice is created.
  billingAddress: Address | null
  type: Generated<string>
  // Stamped once the payment is recorded in Fakturoid; NULL on a paid invoice → retry sweep.
  fakturoidPaidAt: Timestamp | null
  stripeSessionId: string | null
  stripePaymentIntent: string | null
}

// Stripe webhook event dedupe — the INSERT is the idempotency claim.
export interface ProcessedStripeEventsTable {
  eventId: string
  type: string
  processedAt: Generated<Date>
}

// pg returns bigint as a string; accept number|string on write.
type BigIntCol = ColumnType<string, number | string, number | string>

// Every Fio movement ever fetched (dedupe + audit). PK (account, fio_id) is the
// idempotency claim for payment processing.
export interface FioPaymentsTable {
  account: 'CZK' | 'EUR'
  fioId: BigIntCol
  amount: Numeric
  currency: string
  vs: string | null
  counterAccount: string | null
  counterName: string | null
  message: string | null
  paidOn: Timestamp
  matchedInvoiceId: string | null
  status: Generated<string>
  raw: unknown
  created: Generated<Date>
}

// Durable cache of Vincario VIN decodes (permanent, keyed by VIN). raw_response keeps the
// verbatim payload for audit / future re-mapping.
export interface VinDecodeCacheTable {
  vin: string
  normalized: NormalizedVin
  rawResponse: VincarioDecodeResponse
  price: Numeric | null
  priceCurrency: string | null
  decodedBy: string | null
  decodedAt: Generated<Date>
}

// Public contact-form submissions and price offers on listings. item_id/user_id are soft
// references (no FK) so a message survives deletion of the item or user it points at.
export interface ContactMessagesTable {
  id: string
  kind: 'contact' | 'offer'
  name: string | null
  email: string | null
  phone: string | null
  location: string | null
  vehicle: string | null
  message: string | null
  itemId: string | null
  userId: string | null
  offerAmount: Numeric | null
  offerCurrency: string | null
  status: Generated<string>
  notifiedAt: Timestamp | null
  created: Generated<Date>
}

// API tokens for third-party programmatic access. Only the HMAC-SHA256 hash is
// stored (pepper = INTERNAL_API_SECRET); the raw `grg_…` token is shown once.
export interface ApiTokensTable {
  id: string
  name: string
  tokenHash: string
  tokenPrefix: string
  createdBy: string
  createdAt: Generated<Date>
  lastUsedAt: Timestamp | null
}

// Recommendation engine (docs/recommendation-algorithm.md §4). Append-only event log
// + precompute tables; item_id/category_id are soft references (no FK).
export interface RecommendationEventsTable {
  id: string // client UUID — idempotency key
  vid: string
  userId: string | null
  sessionId: string | null
  type: string
  itemId: string | null
  categoryId: string | null
  value: Numeric | null
  surface: string | null
  position: number | null
  propensity: Numeric | null
  meta: TrackEventMeta | null
  occurredAt: Timestamp
  createdAt: Generated<Date>
}

export interface VisitorProfilesTable {
  vid: string
  userId: string | null
  features: VisitorFeatureVector
  topMakes: Array<[string, number]>
  nEff: Numeric
  alpha: Numeric
  lastEventAt: Timestamp | null
  updatedAt: Generated<Date>
}

export interface ItemFeaturesTable {
  itemId: string
  vector: ItemVector
  popScore: Numeric
  trendScore: Numeric
  engagementSum: Numeric
  impressionCount: Numeric
  distinctViewers: number
  qualityScore: Numeric
  updatedAt: Generated<Date>
}

export interface AttributeAffinityTable {
  dimension: string
  valueA: string
  valueB: string
  score: Numeric
  updatedAt: Generated<Date>
}

export interface PopularitySegmentsTable {
  segmentKey: string
  ranking: PopularityRankingEntry[]
  updatedAt: Generated<Date>
}

// A user's saved search (the saved-search domain). query is the stored SearchQuery (jsonb); a JS
// object serializes to jsonb fine — only a leaked array would need JSON.stringify (the jsonbArray
// gotcha), and the query is always an object. last_alerted_at is the server-only CAS column for the
// alert cron (never mapped onto the SavedSearch model — parity with users.newsletter_last_sent_at).
export interface SavedSearchesTable {
  id: string
  userId: string
  name: string
  query: SearchQuery
  alertEnabled: Generated<boolean>
  // Server-only alert CAS stamp; NULL = never alerted (alerted first). Not on the SavedSearch model.
  lastAlertedAt: Timestamp | null
  createdAt: Generated<Date>
  updatedAt: Timestamp | null
}

export interface Database {
  users: UsersTable
  savedSearches: SavedSearchesTable
  items: ItemsTable
  bids: BidsTable
  itemQuestions: ItemQuestionsTable
  itemRatings: ItemRatingsTable
  disputes: DisputesTable
  notifications: NotificationsTable
  jobRuns: JobRunsTable
  auditLog: AuditLogTable
  invoices: InvoicesTable
  fioPayments: FioPaymentsTable
  processedStripeEvents: ProcessedStripeEventsTable
  vinDecodeCache: VinDecodeCacheTable
  apiTokens: ApiTokensTable
  contactMessages: ContactMessagesTable
  recommendationEvents: RecommendationEventsTable
  visitorProfiles: VisitorProfilesTable
  itemFeatures: ItemFeaturesTable
  attributeAffinity: AttributeAffinityTable
  popularitySegments: PopularitySegmentsTable
}

export type UserRow = Selectable<UsersTable>
export type UserInsert = Insertable<UsersTable>
export type UserUpdate = Updateable<UsersTable>
export type ItemRow = Selectable<ItemsTable>
export type ItemInsert = Insertable<ItemsTable>
export type ItemUpdate = Updateable<ItemsTable>
export type BidRow = Selectable<BidsTable>
export type BidInsert = Insertable<BidsTable>
export type QuestionRow = Selectable<ItemQuestionsTable>
export type QuestionInsert = Insertable<ItemQuestionsTable>
export type QuestionUpdate = Updateable<ItemQuestionsTable>
export type InvoiceRow = Selectable<InvoicesTable>
export type InvoiceInsert = Insertable<InvoicesTable>
export type VinDecodeCacheRow = Selectable<VinDecodeCacheTable>
export type VinDecodeCacheInsert = Insertable<VinDecodeCacheTable>
export type ApiTokenInsert = Insertable<ApiTokensTable>
export type ContactMessageRow = Selectable<ContactMessagesTable>
export type ContactMessageInsert = Insertable<ContactMessagesTable>
export type RecommendationEventRow = Selectable<RecommendationEventsTable>
export type RecommendationEventInsert = Insertable<RecommendationEventsTable>
export type VisitorProfileRow = Selectable<VisitorProfilesTable>
export type VisitorProfileInsert = Insertable<VisitorProfilesTable>
export type ItemFeaturesRow = Selectable<ItemFeaturesTable>
export type ItemFeaturesInsert = Insertable<ItemFeaturesTable>
export type AttributeAffinityRow = Selectable<AttributeAffinityTable>
export type AttributeAffinityInsert = Insertable<AttributeAffinityTable>
export type PopularitySegmentRow = Selectable<PopularitySegmentsTable>
export type PopularitySegmentInsert = Insertable<PopularitySegmentsTable>
export type SavedSearchRow = Selectable<SavedSearchesTable>
export type SavedSearchInsert = Insertable<SavedSearchesTable>
export type SavedSearchUpdate = Updateable<SavedSearchesTable>
