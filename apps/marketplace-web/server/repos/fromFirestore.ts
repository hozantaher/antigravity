import type { Address, AdHighlight, Bid, Currency, Gps, Invoice, Item, Language, Price, User, Winner } from '~/models'
// Relative (not ~) so the tsx-run migration script can resolve the enum values.
import { AuthType, UserRole } from '../../models'
import { itemTypeFromString } from './mappers'
import { languages } from '../data/fixtures'

// The legacy app wrote its documents verbatim (no Firestore converter), so a doc
// is the old model shape: Firestore Timestamps, a numeric authType, bids embedded
// as an array, prices with an inlined currency object, and localized
// description/highlights maps. These adapters normalize that into the `~/models`
// shape; the existing model→insert mappers then build the actual DB rows.

type Doc = Record<string, unknown>

// items.category_id has a CHECK constraint — unknown legacy categories collapse here.
const ALLOWED_CATEGORIES = new Set([
  'car',
  'moto',
  'motorhome',
  'vut75',
  'to75',
  'av',
  'stt',
  't',
  'st',
  'cm',
  'bus',
  'ft',
  'others',
])

// Firestore Timestamp | Date | ms number | ISO/Fakturoid string | {seconds,nanoseconds} → epoch ms.
export const toMillis = (v: unknown): number | undefined => {
  if (v == null) return undefined
  if (typeof v === 'number') return v
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.toMillis === 'function') return (o.toMillis as () => number)()
    if (typeof o.toDate === 'function') return (o.toDate as () => Date)().getTime()
    const secs = (o.seconds ?? o._seconds) as number | undefined
    if (typeof secs === 'number') {
      const nanos = (o.nanoseconds ?? o._nanoseconds ?? 0) as number
      return secs * 1000 + Math.floor(nanos / 1e6)
    }
  }
  return undefined
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

// Preserve any roles present (notably 'admin'); default to ['user'] when absent.
const normalizeRoles = (v: unknown): UserRole[] => {
  const roles = arr<unknown>(v).filter((r): r is string => typeof r === 'string')
  return (roles.length ? roles : ['user']) as UserRole[]
}

const normalizeCategory = (v: unknown): string => (typeof v === 'string' && ALLOWED_CATEGORIES.has(v) ? v : 'others')

export const firestoreToUser = (id: string, d: Doc): User => ({
  id,
  // Legacy authType is the same numeric enum (0 anon, 1 email, 2 fb, 3 google).
  authType: typeof d.authType === 'number' ? (d.authType as AuthType) : AuthType.email,
  fullName: str(d.fullName) ?? str(d.email) ?? 'User',
  email: str(d.email) ?? '',
  companyName: str(d.companyName),
  companyVatNumber: str(d.companyVatNumber),
  companyIdNumber: str(d.companyIdNumber),
  bankAccount: str(d.bankAccount),
  phone: str(d.phone),
  address: (d.address as Address) ?? undefined,
  vat: num(d.vat),
  roles: normalizeRoles(d.roles),
  depositBalance: (d.depositBalance as Price | undefined) ?? {},
  fakturoidId: num(d.fakturoidId),
  invoiceDueDays: num(d.invoiceDueDays) ?? 14,
  favoriteIds: arr<string>(d.favoriteIds),
  language: (d.language as Language | undefined) ?? languages[0]!,
  newsletter: d.newsletter === true,
  depositRequired: typeof d.depositRequired === 'boolean' ? d.depositRequired : undefined,
  emailVerified: typeof d.emailVerified === 'boolean' ? d.emailVerified : undefined,
})

// FK-only placeholder for a userId referenced by an ad/bid but missing from the
// users collection. Keeps the UID so a real login can still adopt the row later.
export const placeholderUser = (id: string): User => ({
  id,
  authType: AuthType.email,
  fullName: 'Unknown',
  email: '',
  roles: [UserRole.user],
  depositBalance: {},
  invoiceDueDays: 14,
  favoriteIds: [],
  language: languages[0]!,
  newsletter: false,
})

export const firestoreToItem = (id: string, d: Doc): Item => ({
  id,
  internalId: str(d.internalId),
  title: str(d.title) ?? '',
  image: str(d.image) ?? '',
  images: arr<string>(d.images),
  images360: arr<string>(d.images360),
  description: (d.description as Record<string, string>) ?? {},
  highlights: (d.highlights as Record<string, AdHighlight[]>) ?? {},
  minimalPrice: d.minimalPrice as Price | undefined,
  priceFrom: d.priceFrom as Price | undefined,
  minBid: d.minBid as Price | undefined,
  categoryId: normalizeCategory(d.categoryId),
  userId: str(d.userId) ?? '',
  bids: [], // embedded bids are migrated separately into the bids table
  location: str(d.location),
  countryCode: str(d.countryCode),
  youtubeVideoId: str(d.youtubeVideoId),
  priceHighlighted: d.priceHighlighted === true,
  taxIncluded: d.taxIncluded === true,
  sold: d.sold === true,
  closed: d.closed === true,
  hidden: d.hidden === true,
  winner: (d.winner as Winner) ?? undefined,
  email: str(d.email),
  phone: str(d.phone),
  startDate: toMillis(d.startDate),
  endDate: toMillis(d.endDate),
  type: itemTypeFromString(str(d.type) ?? 'auction'),
  created: toMillis(d.created),
  updated: toMillis(d.updated),
  visibleUpdated: toMillis(d.visibleUpdated),
  gps: (d.gps as Gps) ?? undefined,
})

// Legacy bids live as an embedded array on the ad doc.
export const firestoreToBids = (d: Doc): Bid[] =>
  arr<Doc>(d.bids).map(b => ({
    userId: str(b.userId) ?? '',
    date: toMillis(b.date) ?? 0,
    amount: num(b.amount),
    currency: (b.currency as Currency) ?? undefined,
    avatarUrl: str(b.avatarUrl),
  }))

export const firestoreToInvoice = (id: string, d: Doc): Invoice => ({
  id,
  userId: str(d.userId) ?? '',
  status: str(d.status) ?? 'unpaid',
  price: d.price as Price | undefined,
  createdDate: toMillis(d.createdDate),
  invoiceCreatedDate: toMillis(d.invoiceCreatedDate),
  invoiceDueDate: toMillis(d.invoiceDueDate),
  paidAt: toMillis(d.paidAt),
  url: str(d.url),
})
