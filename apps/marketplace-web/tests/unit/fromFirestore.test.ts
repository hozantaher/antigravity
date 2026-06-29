import { describe, it, expect } from 'vitest'
import type { Item, User } from '~/models'
import { AuthType, ItemType, UserRole } from '~/models'
import {
  userToInsert,
  itemToInsert,
  bidToInsert,
  invoiceToInsert,
  currencyByCode,
  languageByCode,
  itemTypeFromString,
  rowToBid,
  rowToItem,
  cardRowToItem,
  toLiveItem,
  rowToUser,
  rowToInvoice,
  rowToContactMessage,
  apiTokenRowToModel,
  itemPatchToUpdate,
  userProfilePatchToUpdate,
} from '~/server/repos/mappers'
import type { BidRow, ContactMessageRow, InvoiceRow, ItemRow, UserRow } from '~/server/db/schema'
import type { CardItemRow, LiveItemRow, ApiTokenJoinRow } from '~/server/repos/mappers'
import {
  firestoreToUser,
  firestoreToItem,
  firestoreToBids,
  firestoreToInvoice,
  placeholderUser,
  toMillis,
} from '~/server/repos/fromFirestore'

// Mimics a firebase-admin Firestore Timestamp (duck-typed via toMillis/toDate).
const ts = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) })
const EUR = { code: 'EUR', symbol: '€', symbolBefore: false }

describe('toMillis', () => {
  it('handles Timestamp, Date, number, ISO string and {seconds,nanoseconds}', () => {
    expect(toMillis(ts(1000))).toBe(1000)
    expect(toMillis(new Date(1735689600000))).toBe(1735689600000)
    expect(toMillis(123)).toBe(123)
    expect(toMillis('2025-01-01T00:00:00Z')).toBe(Date.parse('2025-01-01T00:00:00Z'))
    expect(toMillis({ seconds: 2, nanoseconds: 500_000_000 })).toBe(2500)
    expect(toMillis(undefined)).toBeUndefined()
    expect(toMillis('not-a-date')).toBeUndefined()
  })
})

describe('firestoreToUser', () => {
  const doc = {
    id: 'uid-1',
    authType: 1, // legacy numeric: email
    email: 'jan@auction24.cz',
    fullName: 'Jan Novák',
    phone: '+420111',
    companyName: 'Novák s.r.o.',
    companyVatNumber: 'CZ123',
    companyIdNumber: '123',
    roles: ['user', 'admin'],
    depositBalance: { amount: 5000, currency: EUR },
    invoiceDueDays: 30,
    favoriteIds: ['i2', 'i7'],
    language: { code: 'cz', name: 'Čeština', cs: '', en: '' },
    newsletter: true,
    address: { country: { code2: 'cz' } },
  }

  it('maps numeric authType, preserves admin role, and round-trips to an insert', () => {
    const u = firestoreToUser('uid-1', doc)
    expect(u.authType).toBe(AuthType.email)
    expect(u.roles).toContain(UserRole.admin)

    const ins = userToInsert(u)
    expect(ins.id).toBe('uid-1')
    expect(ins.authType).toBe('email')
    expect(ins.roles).toEqual(['user', 'admin'])
    expect(ins.depositBalanceAmount).toBe(5000)
    expect(ins.depositBalanceCurrency).toBe('EUR')
    expect(ins.languageCode).toBe('cz')
    expect(ins.invoiceDueDays).toBe(30)
    expect(ins.favoriteIds).toEqual(['i2', 'i7'])
  })

  it('fills defaults for a sparse doc', () => {
    const u = firestoreToUser('uid-2', { email: 'x@y.cz' })
    expect(u.fullName).toBe('x@y.cz')
    expect(u.roles).toEqual([UserRole.user])
    expect(u.invoiceDueDays).toBe(14)
    expect(u.language.code).toBe('cz')
    expect(userToInsert(u).depositBalanceAmount).toBeNull()
  })

  it('maps facebook/google numeric providers', () => {
    expect(userToInsert(firestoreToUser('a', { authType: 2 })).authType).toBe('facebook')
    expect(userToInsert(firestoreToUser('b', { authType: 3 })).authType).toBe('google')
  })
})

describe('placeholderUser', () => {
  it('is an FK-safe minimal row keyed by uid', () => {
    const ins = userToInsert(placeholderUser('ghost'))
    expect(ins.id).toBe('ghost')
    expect(ins.roles).toEqual(['user'])
    expect(ins.email).toBe('')
  })
})

describe('firestoreToItem', () => {
  const doc = {
    title: 'Mercedes',
    image: 'cover.jpg',
    images: ['a.jpg'],
    description: { cz: 'popis' },
    highlights: { cz: [{ title: 'Rok', value: '2019' }] },
    priceFrom: { amount: 28000, currency: EUR },
    minimalPrice: { amount: 32000, currency: EUR },
    categoryId: 'car',
    userId: 'uid-1',
    type: 'auction',
    sold: false,
    startDate: ts(1735689600000),
    endDate: ts(1735862400000),
    created: ts(1735000000000),
    bids: [{ userId: 'b1', amount: 28500, currency: EUR, date: ts(1735700000000) }],
  }

  it('converts timestamps, prices and type through the existing insert mapper', () => {
    const item = firestoreToItem('ad-1', doc)
    expect(item.type).toBe(ItemType.auction)
    expect(item.startDate).toBe(1735689600000)
    expect(item.bids).toEqual([]) // embedded bids handled separately

    const ins = itemToInsert(item)
    expect(ins.type).toBe('auction')
    expect(ins.priceFromAmount).toBe(28000)
    expect(ins.priceFromCurrency).toBe('EUR')
    expect(ins.startDate).toBeInstanceOf(Date)
    expect((ins.startDate as Date).getTime()).toBe(1735689600000)
    expect(ins.sold).toBe(false)
  })

  it('normalizes an unknown category to others and defaults missing flags', () => {
    const item = firestoreToItem('ad-2', { title: 'x', userId: 'u', categoryId: 'spaceship', type: 'ad' })
    expect(item.categoryId).toBe('others')
    expect(item.type).toBe(ItemType.ad)
    expect(item.priceHighlighted).toBe(false)

    const ins = itemToInsert(item)
    expect(ins.categoryId).toBe('others')
    expect(ins.type).toBe('ad')
  })

  it('extracts embedded bids into insert rows', () => {
    const bids = firestoreToBids(doc)
    expect(bids).toHaveLength(1)

    const ins = bidToInsert('ad-1', bids[0]!)
    expect(ins.itemId).toBe('ad-1')
    expect(ins.userId).toBe('b1')
    expect(ins.amount).toBe(28500)
    expect(ins.currencyCode).toBe('EUR')
    expect((ins.date as Date).getTime()).toBe(1735700000000)
  })
})

describe('firestoreToInvoice', () => {
  it('maps status, price and mixed-type dates', () => {
    const inv = firestoreToInvoice('inv-1', {
      userId: 'uid-1',
      status: 'paid',
      price: { amount: 2500, currency: { code: 'CZK', symbol: 'Kč', symbolBefore: false } },
      createdDate: ts(1735000000000),
      paidAt: '2025-01-05T10:00:00Z',
    })

    const ins = invoiceToInsert(inv)
    expect(ins.userId).toBe('uid-1')
    expect(ins.status).toBe('paid')
    expect(ins.priceAmount).toBe(2500)
    expect(ins.priceCurrency).toBe('CZK')
    expect(ins.createdDate).toBeInstanceOf(Date)
    expect(ins.paidAt).toBeInstanceOf(Date)
  })

  it('defaults status to unpaid for a sparse doc', () => {
    expect(firestoreToInvoice('inv-2', { userId: 'u' }).status).toBe('unpaid')
  })
})

// Edge encodings + optional-field branches — wires the cell to its 98/90 self-measure gate.
describe('toMillis alternate encodings', () => {
  it('reads a toDate-only object, the _seconds/_nanoseconds variant, and rejects junk', () => {
    expect(toMillis({ toDate: () => new Date(5000) })).toBe(5000)
    expect(toMillis({ _seconds: 1, _nanoseconds: 500_000_000 })).toBe(1500)
    expect(toMillis({ seconds: 3 })).toBe(3000) // nanoseconds defaulting to 0
    expect(toMillis({ nope: true })).toBeUndefined()
  })
})

describe('firestoreToUser optional fields', () => {
  it('preserves bank/vat/fakturoid and the deposit/email booleans', () => {
    const u = firestoreToUser('uid-3', {
      authType: 0,
      email: 'a@b.cz',
      bankAccount: '123/0300',
      vat: 21,
      fakturoidId: 99,
      depositRequired: true,
      emailVerified: false,
    })
    expect(u.bankAccount).toBe('123/0300')
    expect(u.vat).toBe(21)
    expect(u.fakturoidId).toBe(99)
    expect(u.depositRequired).toBe(true)
    expect(u.emailVerified).toBe(false)
  })

  it("falls back to 'User' with neither name nor email, and drops non-string roles", () => {
    const u = firestoreToUser('uid-4', { roles: ['user', 5] })
    expect(u.fullName).toBe('User')
    expect(u.roles).toEqual([UserRole.user])
  })
})

describe('firestoreToItem optional fields', () => {
  it('maps winner/gps/minBid/location and the true flags', () => {
    const item = firestoreToItem('ad-3', {
      title: 't',
      userId: 'u',
      categoryId: 'car',
      type: 'auction',
      internalId: 'INT-1',
      images360: ['p.jpg'],
      minBid: { amount: 100, currency: EUR },
      location: 'Brno',
      countryCode: 'cz',
      youtubeVideoId: 'yt',
      email: 'e@x.cz',
      phone: '+420',
      priceHighlighted: true,
      taxIncluded: true,
      sold: true,
      closed: true,
      hidden: true,
      winner: { id: 'w', name: 'W' },
      gps: { lat: 1, lng: 2 },
      updated: 123,
      visibleUpdated: 456,
    })
    expect(item.internalId).toBe('INT-1')
    expect(item.images360).toEqual(['p.jpg'])
    expect(item.location).toBe('Brno')
    expect(item.hidden).toBe(true)
    expect(item.winner).toEqual({ id: 'w', name: 'W' })
    expect(item.gps).toEqual({ lat: 1, lng: 2 })
  })
})

describe('firestoreToBids sparse', () => {
  it('defaults missing bid fields and returns [] for a non-array', () => {
    expect(firestoreToBids({ bids: [{}] })).toEqual([
      { userId: '', date: 0, amount: undefined, currency: undefined, avatarUrl: undefined },
    ])
    expect(firestoreToBids({})).toEqual([])
  })
})

// ---- Row → model mappers (server/repos/mappers.ts) -------------------------

describe('reference rehydration', () => {
  it('currencyByCode resolves a known code and returns undefined for null/unknown', () => {
    expect(currencyByCode('EUR')?.symbol).toBe('€')
    expect(currencyByCode(null)).toBeUndefined()
    expect(currencyByCode(undefined)).toBeUndefined()
    expect(currencyByCode('XYZ')).toBeUndefined()
  })

  it('languageByCode resolves a known code and defaults to the first locale', () => {
    expect(languageByCode('en').code).toBe('en')
    expect(languageByCode(null).code).toBe('cz')
    expect(languageByCode(undefined).code).toBe('cz')
    expect(languageByCode('zzz').code).toBe('cz') // unknown → fallback to languages[0]
  })

  it('itemTypeFromString maps ad vs auction', () => {
    expect(itemTypeFromString('ad')).toBe(ItemType.ad)
    expect(itemTypeFromString('auction')).toBe(ItemType.auction)
    expect(itemTypeFromString('anything-else')).toBe(ItemType.auction)
  })
})

describe('rowToBid', () => {
  const base: BidRow = {
    id: 1,
    itemId: 'i1',
    userId: 'b1',
    amount: '500',
    currencyCode: 'EUR',
    date: new Date(1700000000000),
    avatarUrl: 'https://x/a.png',
  } as unknown as BidRow

  it('maps a fully populated row', () => {
    const bid = rowToBid(base)
    expect(bid.userId).toBe('b1')
    expect(bid.date).toBe(1700000000000)
    expect(bid.amount).toBe(500)
    expect(bid.currency?.code).toBe('EUR')
    expect(bid.avatarUrl).toBe('https://x/a.png')
  })

  it('drops null amount/currency/avatar', () => {
    const bid = rowToBid({ ...base, amount: null, currencyCode: null, avatarUrl: null } as unknown as BidRow)
    expect(bid.amount).toBeUndefined()
    expect(bid.currency).toBeUndefined()
    expect(bid.avatarUrl).toBeUndefined()
  })
})

const fullItemRow: ItemRow = {
  id: 'i1',
  internalId: 'INT-1',
  title: 'Mercedes',
  image: 'cover.jpg',
  images: ['a.jpg'],
  images360: ['p.jpg'],
  description: { cz: 'popis' },
  highlights: { cz: [] },
  minimalPriceAmount: '32000',
  minimalPriceCurrency: 'EUR',
  priceFromAmount: '28000',
  priceFromCurrency: 'EUR',
  minBidAmount: '100',
  minBidCurrency: 'EUR',
  categoryId: 'car',
  userId: 'u1',
  location: 'Brno',
  countryCode: 'cz',
  youtubeVideoId: 'yt',
  priceHighlighted: true,
  taxIncluded: true,
  sold: false,
  closed: false,
  hidden: false,
  winner: { id: 'w', name: 'W' },
  email: 'e@x.cz',
  phone: '+420',
  startDate: new Date(1735689600000),
  endDate: new Date(1735862400000),
  type: 'auction',
  created: new Date(1735000000000),
  updated: new Date(1735100000000),
  visibleUpdated: new Date(1735200000000),
  gps: { lat: 1, lng: 2 },
  vin: 'WDB123',
  fuelType: 'diesel',
  transmission: 'manual',
  bodyType: 'sedan',
  driveType: 'fwd',
  enginePowerKw: 110,
  engineDisplacementCcm: 1998,
  color: 'black',
  firstRegistrationDate: '2019-01-01',
  specs: { manufacturer: 'Mercedes' },
} as unknown as ItemRow

const nullItemRow: ItemRow = {
  id: 'i2',
  internalId: null,
  title: 't',
  image: '',
  images: [],
  images360: [],
  description: null,
  highlights: null,
  minimalPriceAmount: null,
  minimalPriceCurrency: null,
  priceFromAmount: null,
  priceFromCurrency: null,
  minBidAmount: null,
  minBidCurrency: null,
  categoryId: 'car',
  userId: 'u1',
  location: null,
  countryCode: null,
  youtubeVideoId: null,
  priceHighlighted: false,
  taxIncluded: false,
  sold: false,
  closed: false,
  hidden: false,
  winner: null,
  email: null,
  phone: null,
  startDate: null,
  endDate: null,
  type: 'ad',
  created: null,
  updated: null,
  visibleUpdated: null,
  gps: null,
  vin: null,
  fuelType: null,
  transmission: null,
  bodyType: null,
  driveType: null,
  enginePowerKw: null,
  engineDisplacementCcm: null,
  color: null,
  firstRegistrationDate: null,
  specs: null,
} as unknown as ItemRow

describe('rowToItem', () => {
  it('maps every populated column and the embedded bids', () => {
    const bidRow = {
      id: 1,
      itemId: 'i1',
      userId: 'b1',
      amount: '500',
      currencyCode: 'EUR',
      date: new Date(1700000000000),
      avatarUrl: null,
    } as unknown as BidRow
    const item = rowToItem(fullItemRow, [bidRow])
    expect(item.internalId).toBe('INT-1')
    expect(item.description).toEqual({ cz: 'popis' })
    expect(item.minimalPrice?.amount).toBe(32000)
    expect(item.priceFrom?.amount).toBe(28000)
    expect(item.minBid?.amount).toBe(100)
    expect(item.bids).toHaveLength(1)
    expect(item.location).toBe('Brno')
    expect(item.youtubeVideoId).toBe('yt')
    expect(item.winner).toEqual({ id: 'w', name: 'W' })
    expect(item.startDate).toBe(1735689600000)
    expect(item.type).toBe(ItemType.auction)
    expect(item.created).toBe(1735000000000)
    expect(item.visibleUpdated).toBe(1735200000000)
    expect(item.fuelType).toBe('diesel')
    expect(item.enginePowerKw).toBe(110)
    expect(item.firstRegistrationDate).toBe('2019-01-01')
    expect(item.specs).toEqual({ manufacturer: 'Mercedes' })
  })

  it('blanks all nullable columns (and defaults bids to []) for a null row', () => {
    const item = rowToItem(nullItemRow)
    expect(item.internalId).toBeUndefined()
    expect(item.description).toEqual({})
    expect(item.highlights).toEqual({})
    expect(item.minimalPrice).toBeUndefined()
    expect(item.priceFrom).toBeUndefined()
    expect(item.minBid).toBeUndefined()
    expect(item.bids).toEqual([])
    expect(item.location).toBeUndefined()
    expect(item.winner).toBeUndefined()
    expect(item.startDate).toBeUndefined()
    expect(item.endDate).toBeUndefined()
    expect(item.created).toBeUndefined()
    expect(item.updated).toBeUndefined()
    expect(item.visibleUpdated).toBeUndefined()
    expect(item.gps).toBeUndefined()
    expect(item.fuelType).toBeUndefined()
    expect(item.color).toBeUndefined()
    expect(item.firstRegistrationDate).toBeUndefined()
    expect(item.specs).toBeUndefined()
    expect(item.type).toBe(ItemType.ad)
  })
})

describe('cardRowToItem', () => {
  const cardRow: CardItemRow = {
    id: 'i1',
    internalId: 'INT-1',
    title: 'Card',
    image: 'c.jpg',
    images: ['a.jpg'],
    images360: [],
    minimalPriceAmount: '500',
    minimalPriceCurrency: 'EUR',
    priceFromAmount: null,
    priceFromCurrency: null,
    minBidAmount: null,
    minBidCurrency: null,
    categoryId: 'car',
    userId: 'u1',
    location: 'Praha',
    countryCode: 'cz',
    priceHighlighted: true,
    taxIncluded: false,
    sold: false,
    closed: false,
    hidden: false,
    startDate: new Date(1735689600000),
    endDate: new Date(1735862400000),
    type: 'auction',
    created: new Date(1735000000000),
    updated: null,
    visibleUpdated: null,
  } as unknown as CardItemRow

  it('attaches the last bid + count when a summary is given', () => {
    const last = rowToBid({
      id: 1,
      itemId: 'i1',
      userId: 'b1',
      amount: '600',
      currencyCode: 'EUR',
      date: new Date(1700000000000),
      avatarUrl: null,
    } as unknown as BidRow)
    const item = cardRowToItem(cardRow, { count: 4, last })
    expect(item.bids).toEqual([last])
    expect(item.bidCount).toBe(4)
    expect(item.description).toEqual({})
    expect(item.minimalPrice?.amount).toBe(500)
    expect(item.location).toBe('Praha')
    expect(item.type).toBe(ItemType.auction)
    expect(item.created).toBe(1735000000000)
  })

  it('falls back to empty bids + zero count without a summary', () => {
    const item = cardRowToItem({
      ...cardRow,
      internalId: null,
      location: null,
      countryCode: null,
    } as unknown as CardItemRow)
    expect(item.bids).toEqual([])
    expect(item.bidCount).toBe(0)
    expect(item.internalId).toBeUndefined()
    expect(item.location).toBeUndefined()
    expect(item.countryCode).toBeUndefined()
    expect(item.updated).toBeUndefined()
  })
})

describe('toLiveItem', () => {
  const liveRow: LiveItemRow = {
    id: 'i1',
    endDate: new Date(1735862400000),
    sold: true,
    closed: false,
    winner: { id: 'w', name: 'W' },
  } as unknown as LiveItemRow

  it('carries the last bid + count + winner from a summary', () => {
    const last = rowToBid({
      id: 1,
      itemId: 'i1',
      userId: 'b1',
      amount: '600',
      currencyCode: 'EUR',
      date: new Date(1700000000000),
      avatarUrl: null,
    } as unknown as BidRow)
    const live = toLiveItem(liveRow, { count: 7, last })
    expect(live.lastBid).toBe(last)
    expect(live.bidCount).toBe(7)
    expect(live.endDate).toBe(1735862400000)
    expect(live.winner).toEqual({ id: 'w', name: 'W' })
  })

  it('defaults to no bid / zero count / no winner', () => {
    const live = toLiveItem({ ...liveRow, endDate: null, winner: null } as unknown as LiveItemRow)
    expect(live.lastBid).toBeUndefined()
    expect(live.bidCount).toBe(0)
    expect(live.endDate).toBeUndefined()
    expect(live.winner).toBeUndefined()
  })
})

const fullUserRow: UserRow = {
  id: 'u1',
  authType: 'google',
  fullName: 'Jan',
  email: 'jan@x.cz',
  companyName: 'Co',
  companyVatNumber: 'CZ1',
  companyIdNumber: '1',
  bankAccount: '123/0300',
  phone: '+420',
  address: { country: { code2: 'cz' } },
  vat: '21',
  roles: ['user', 'admin'],
  depositBalanceAmount: '5000',
  depositBalanceCurrency: 'EUR',
  fakturoidId: 99,
  invoiceDueDays: 30,
  favoriteIds: ['i2'],
  languageCode: 'en',
  newsletter: true,
  depositRequired: false,
  emailVerified: true,
} as unknown as UserRow

describe('rowToUser', () => {
  it('maps a fully populated row', () => {
    const u = rowToUser(fullUserRow)
    expect(u.authType).toBe(AuthType.google)
    expect(u.companyName).toBe('Co')
    expect(u.bankAccount).toBe('123/0300')
    expect(u.vat).toBe(21)
    expect(u.roles).toContain(UserRole.admin)
    expect(u.depositBalance.amount).toBe(5000)
    expect(u.depositBalance.currency?.code).toBe('EUR')
    expect(u.fakturoidId).toBe(99)
    expect(u.language.code).toBe('en')
    expect(u.depositRequired).toBe(false)
    expect(u.emailVerified).toBe(true)
  })

  it('drops nulls and defaults the deposit balance to 0 / EUR', () => {
    const u = rowToUser({
      ...fullUserRow,
      authType: 'facebook',
      companyName: null,
      companyVatNumber: null,
      companyIdNumber: null,
      bankAccount: null,
      phone: null,
      address: null,
      vat: null,
      depositBalanceAmount: null,
      depositBalanceCurrency: null,
      fakturoidId: null,
      languageCode: null,
    } as unknown as UserRow)
    expect(u.authType).toBe(AuthType.facebook)
    expect(u.companyName).toBeUndefined()
    expect(u.bankAccount).toBeUndefined()
    expect(u.vat).toBeUndefined()
    expect(u.depositBalance.amount).toBe(0)
    expect(u.depositBalance.currency?.code).toBe('EUR')
    expect(u.fakturoidId).toBeUndefined()
    expect(u.language.code).toBe('cz')
  })

  it('maps the email authType branch', () => {
    expect(rowToUser({ ...fullUserRow, authType: 'email' } as unknown as UserRow).authType).toBe(AuthType.email)
  })
})

describe('rowToInvoice', () => {
  const base: InvoiceRow = {
    id: 'inv-1',
    userId: 'u1',
    createdDate: new Date(1735000000000),
    invoiceCreatedDate: new Date(1735100000000),
    invoiceDueDate: new Date(1735200000000),
    paidAt: new Date(1735300000000),
    status: 'paid',
    priceAmount: '2500',
    priceCurrency: 'CZK',
    url: 'https://x/inv.pdf',
  } as unknown as InvoiceRow

  it('maps a populated invoice', () => {
    const inv = rowToInvoice(base)
    expect(inv.createdDate).toBe(1735000000000)
    expect(inv.paidAt).toBe(1735300000000)
    expect(inv.price?.amount).toBe(2500)
    expect(inv.price?.currency?.code).toBe('CZK')
    expect(inv.url).toBe('https://x/inv.pdf')
  })

  it('drops nullable dates / price / url', () => {
    const inv = rowToInvoice({
      ...base,
      createdDate: null,
      invoiceCreatedDate: null,
      invoiceDueDate: null,
      paidAt: null,
      priceAmount: null,
      priceCurrency: null,
      url: null,
    } as unknown as InvoiceRow)
    expect(inv.createdDate).toBeUndefined()
    expect(inv.invoiceDueDate).toBeUndefined()
    expect(inv.paidAt).toBeUndefined()
    expect(inv.price).toBeUndefined()
    expect(inv.url).toBeUndefined()
  })
})

describe('rowToContactMessage', () => {
  const base: ContactMessageRow = {
    id: 'c1',
    kind: 'offer',
    name: 'Jan',
    email: 'jan@x.cz',
    phone: '+420',
    location: 'Brno',
    vehicle: 'Mercedes',
    message: 'hi',
    itemId: 'i1',
    userId: 'u1',
    offerAmount: '1000',
    offerCurrency: 'EUR',
    status: 'new',
    notifiedAt: new Date(1735000000000),
    created: new Date(1735100000000),
  } as unknown as ContactMessageRow

  it('maps a populated contact message', () => {
    const msg = rowToContactMessage(base)
    expect(msg.name).toBe('Jan')
    expect(msg.vehicle).toBe('Mercedes')
    expect(msg.itemId).toBe('i1')
    expect(msg.offer?.amount).toBe(1000)
    expect(msg.status).toBe('new')
    expect(msg.notifiedAt).toBe(1735000000000)
    expect(msg.created).toBe(1735100000000)
  })

  it('drops every nullable field', () => {
    const msg = rowToContactMessage({
      ...base,
      name: null,
      email: null,
      phone: null,
      location: null,
      vehicle: null,
      message: null,
      itemId: null,
      userId: null,
      offerAmount: null,
      offerCurrency: null,
      notifiedAt: null,
    } as unknown as ContactMessageRow)
    expect(msg.name).toBeUndefined()
    expect(msg.itemId).toBeUndefined()
    expect(msg.userId).toBeUndefined()
    expect(msg.offer).toBeUndefined()
    expect(msg.notifiedAt).toBeUndefined()
  })
})

describe('apiTokenRowToModel', () => {
  const base: ApiTokenJoinRow = {
    id: 't1',
    name: 'CI',
    tokenPrefix: 'pk_abc',
    createdBy: 'u1',
    createdByName: 'Jan',
    createdAt: new Date(1735000000000),
    lastUsedAt: new Date(1735100000000),
  }

  it('maps a populated token row', () => {
    const m = apiTokenRowToModel(base)
    expect(m.createdByName).toBe('Jan')
    expect(m.createdAt).toBe(1735000000000)
    expect(m.lastUsedAt).toBe(1735100000000)
  })

  it('keeps a null createdByName and null lastUsedAt', () => {
    const m = apiTokenRowToModel({ ...base, createdByName: null, lastUsedAt: null })
    expect(m.createdByName).toBeNull()
    expect(m.lastUsedAt).toBeNull()
  })
})

describe('itemPatchToUpdate', () => {
  it('returns an empty object for an empty patch', () => {
    expect(itemPatchToUpdate({})).toEqual({})
  })

  it('maps present keys with populated values', () => {
    const patch: Partial<Item> = {
      internalId: 'INT-2',
      title: 'New',
      image: 'i.jpg',
      images: ['a'],
      images360: ['p'],
      description: { cz: 'd' },
      highlights: { cz: [] },
      minimalPrice: { amount: 1, currency: { code: 'EUR', symbol: '€', symbolBefore: false } },
      priceFrom: { amount: 2, currency: { code: 'EUR', symbol: '€', symbolBefore: false } },
      minBid: { amount: 3, currency: { code: 'EUR', symbol: '€', symbolBefore: false } },
      categoryId: 'car',
      location: 'Brno',
      countryCode: 'cz',
      youtubeVideoId: 'yt',
      priceHighlighted: true,
      taxIncluded: true,
      sold: true,
      closed: true,
      hidden: true,
      winner: { id: 'w', name: 'W' },
      email: 'e@x.cz',
      phone: '+420',
      startDate: 1735689600000,
      endDate: 1735862400000,
      type: ItemType.ad,
      gps: { lat: 1, lng: 2, address: 'Brno' },
      vin: 'WDB',
      fuelType: 'diesel',
      transmission: 'manual',
      bodyType: 'sedan',
      driveType: 'fwd',
      enginePowerKw: 110,
      engineDisplacementCcm: 1998,
      color: 'black',
      firstRegistrationDate: '2019',
      specs: { manufacturer: 'M' },
    } as Partial<Item>
    const u = itemPatchToUpdate(patch)
    expect(u.internalId).toBe('INT-2')
    expect(u.title).toBe('New')
    expect(u.minimalPriceAmount).toBe(1)
    expect(u.minimalPriceCurrency).toBe('EUR')
    expect(u.priceFromAmount).toBe(2)
    expect(u.minBidAmount).toBe(3)
    expect(u.priceHighlighted).toBe(true)
    expect(u.type).toBe('ad')
    expect(u.startDate).toBeInstanceOf(Date)
    expect((u.startDate as Date).getTime()).toBe(1735689600000)
    expect(u.endDate).toBeInstanceOf(Date)
    expect(u.winner).toEqual({ id: 'w', name: 'W' })
    expect(u.fuelType).toBe('diesel')
    expect(u.specs).toEqual({ manufacturer: 'M' })
  })

  it('coalesces present-but-nullish keys to nulls/empties', () => {
    const patch = {
      internalId: undefined,
      image: undefined,
      images: undefined,
      images360: undefined,
      description: undefined,
      highlights: undefined,
      minimalPrice: undefined,
      priceFrom: undefined,
      minBid: undefined,
      location: undefined,
      countryCode: undefined,
      youtubeVideoId: undefined,
      winner: undefined,
      email: undefined,
      phone: undefined,
      startDate: undefined,
      endDate: undefined,
      gps: undefined,
      vin: undefined,
      fuelType: undefined,
      transmission: undefined,
      bodyType: undefined,
      driveType: undefined,
      enginePowerKw: undefined,
      engineDisplacementCcm: undefined,
      color: undefined,
      firstRegistrationDate: undefined,
      specs: undefined,
    } as Partial<Item>
    const u = itemPatchToUpdate(patch)
    expect(u.internalId).toBeNull()
    expect(u.image).toBe('')
    expect(u.images).toEqual([])
    expect(u.images360).toEqual([])
    expect(u.description).toBeNull()
    expect(u.minimalPriceAmount).toBeNull()
    expect(u.minimalPriceCurrency).toBeNull()
    expect(u.priceFromAmount).toBeNull()
    expect(u.minBidAmount).toBeNull()
    expect(u.location).toBeNull()
    expect(u.youtubeVideoId).toBeNull()
    expect(u.winner).toBeNull()
    expect(u.startDate).toBeNull()
    expect(u.endDate).toBeNull()
    expect(u.gps).toBeNull()
    expect(u.fuelType).toBeNull()
    expect(u.specs).toBeNull()
  })
})

describe('userProfilePatchToUpdate', () => {
  it('returns an empty object for an empty patch', () => {
    expect(userProfilePatchToUpdate({})).toEqual({})
  })

  it('maps the whitelisted profile fields when present', () => {
    const u = userProfilePatchToUpdate({
      fullName: 'Jan',
      phone: '+420',
      companyName: 'Co',
      companyVatNumber: 'CZ1',
      companyIdNumber: '1',
      bankAccount: '123/0300',
      address: { country: { code2: 'cz' } },
      newsletter: true,
      language: { code: 'en', name: 'English', cs: '', en: '' },
    } as Partial<User>)
    expect(u.fullName).toBe('Jan')
    expect(u.phone).toBe('+420')
    expect(u.companyName).toBe('Co')
    expect(u.bankAccount).toBe('123/0300')
    expect(u.newsletter).toBe(true)
    expect(u.languageCode).toBe('en')
  })

  it('coalesces present-but-nullish whitelisted fields to nulls', () => {
    const u = userProfilePatchToUpdate({
      phone: undefined,
      companyName: undefined,
      companyVatNumber: undefined,
      companyIdNumber: undefined,
      bankAccount: undefined,
      address: undefined,
      language: undefined,
    } as Partial<User>)
    expect(u.phone).toBeNull()
    expect(u.companyName).toBeNull()
    expect(u.companyVatNumber).toBeNull()
    expect(u.companyIdNumber).toBeNull()
    expect(u.bankAccount).toBeNull()
    expect(u.address).toBeNull()
    expect(u.languageCode).toBeNull()
  })
})
