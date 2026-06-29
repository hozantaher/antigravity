import { describe, it, expect } from 'vitest'
import { AuthType, ItemType, UserRole } from '~/models'
import type { ItemRow, UserRow, InvoiceRow, BidRow, ContactMessageRow } from '~/server/db/schema'
import {
  rowToItem,
  rowToUser,
  rowToInvoice,
  rowToBid,
  rowToContactMessage,
  itemToInsert,
  userToInsert,
  bidToInsert,
  currencyByCode,
  languageByCode,
} from '~/server/repos/mappers'

const D = (iso: string) => new Date(iso)

const baseItemRow = (over: Partial<ItemRow> = {}): ItemRow => ({
  id: 'i1',
  internalId: 'I1',
  title: 'Mercedes',
  image: 'img.jpg',
  images: ['a.jpg', 'b.jpg'],
  images360: [],
  description: { cz: 'popis', en: 'desc' },
  highlights: { cz: [{ title: 'Rok', value: '2019' }] },
  minimalPriceAmount: '32000.00',
  minimalPriceCurrency: 'EUR',
  priceFromAmount: '28000.00',
  priceFromCurrency: 'EUR',
  minBidAmount: '500.00',
  minBidCurrency: 'EUR',
  categoryId: 'car',
  userId: 'admin1',
  location: 'Praha',
  countryCode: 'cz',
  youtubeVideoId: null,
  priceHighlighted: true,
  taxIncluded: false,
  sold: false,
  closed: false,
  hidden: false,
  winner: null,
  winnerEmailedAt: null,
  settledAt: null,
  settlementInvoiceId: null,
  email: 'a@b.cz',
  phone: '+420',
  startDate: D('2025-01-01T00:00:00Z'),
  endDate: D('2025-01-03T00:00:00Z'),
  type: 'auction',
  created: D('2024-12-20T00:00:00Z'),
  updated: D('2024-12-28T00:00:00Z'),
  visibleUpdated: D('2024-12-28T00:00:00Z'),
  gps: { lat: 50.05, lng: 14.43, address: 'Praha' },
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
  enrichmentStatus: 'idle',
  enrichmentClaimedAt: null,
  enrichmentAttempts: 0,
  enrichmentError: null,
  ...over,
})

describe('rowToItem', () => {
  it('rebuilds epoch-ms dates and Price objects with rehydrated currency', () => {
    const item = rowToItem(baseItemRow(), [])
    expect(item.startDate).toBe(D('2025-01-01T00:00:00Z').getTime())
    expect(item.endDate).toBe(D('2025-01-03T00:00:00Z').getTime())
    expect(typeof item.startDate).toBe('number')
    expect(item.priceFrom).toEqual({ amount: 28000, currency: { code: 'EUR', symbol: '€', symbolBefore: false } })
    expect(item.minimalPrice?.amount).toBe(32000)
    expect(item.type).toBe(ItemType.auction)
    expect(item.description).toEqual({ cz: 'popis', en: 'desc' })
  })

  it('maps ad type and leaves missing prices undefined', () => {
    const item = rowToItem(
      baseItemRow({ type: 'ad', minimalPriceAmount: null, minimalPriceCurrency: null, startDate: null, endDate: null }),
      [],
    )
    expect(item.type).toBe(ItemType.ad)
    expect(item.minimalPrice).toBeUndefined()
    expect(item.startDate).toBeUndefined()
  })

  it('attaches mapped bids', () => {
    const bidRows: BidRow[] = [
      {
        id: '1',
        itemId: 'i1',
        userId: 'b1',
        amount: '28000.00',
        currencyCode: 'EUR',
        date: D('2025-01-02T00:00:00Z'),
        avatarUrl: null,
      },
    ]
    const item = rowToItem(baseItemRow(), bidRows)
    expect(item.bids).toHaveLength(1)
    expect(item.bids[0]).toMatchObject({ userId: 'b1', amount: 28000, date: D('2025-01-02T00:00:00Z').getTime() })
    expect(item.bids[0]!.currency?.code).toBe('EUR')
  })
})

const baseUserRow = (over: Partial<UserRow> = {}): UserRow => ({
  id: 'u1',
  authType: 'email',
  fullName: 'Jan Novák',
  email: 'jan@auction24.cz',
  companyName: 'Novák s.r.o.',
  companyVatNumber: 'CZ123',
  companyIdNumber: '123',
  bankAccount: '123/0800',
  phone: '+420',
  address: null,
  vat: '21',
  roles: ['user', 'admin'],
  depositBalanceAmount: '5000.00',
  depositBalanceCurrency: 'EUR',
  depositVs: '1234567890',
  invoiceDueDays: 14,
  favoriteIds: ['i2', 'i7'],
  languageCode: 'cz',
  newsletter: true,
  newsletterLastSentAt: null,
  emailVerified: true,
  depositRequired: false,
  fakturoidId: null,
  banned: false,
  tokensValidAfter: D('1970-01-01T00:00:00Z'),
  created: D('2024-01-01T00:00:00Z'),
  deletedAt: null,
  ...over,
})

describe('rowToUser', () => {
  it('maps provider string to numeric AuthType and roles to enum values', () => {
    const user = rowToUser(baseUserRow())
    expect(user.authType).toBe(AuthType.email)
    expect(user.roles).toContain(UserRole.admin)
    expect(user.vat).toBe(21)
    expect(user.depositBalance).toEqual({ amount: 5000, currency: { code: 'EUR', symbol: '€', symbolBefore: false } })
    expect(user.language.code).toBe('cz')
    expect(user.favoriteIds).toEqual(['i2', 'i7'])
  })

  it('maps google/facebook providers and defaults language', () => {
    expect(rowToUser(baseUserRow({ authType: 'google' })).authType).toBe(AuthType.google)
    expect(rowToUser(baseUserRow({ authType: 'facebook' })).authType).toBe(AuthType.facebook)
    expect(rowToUser(baseUserRow({ languageCode: null })).language.code).toBe('cz')
  })

  it('defaults deposit balance to 0 EUR when missing', () => {
    const user = rowToUser(baseUserRow({ depositBalanceAmount: null, depositBalanceCurrency: null }))
    expect(user.depositBalance.amount).toBe(0)
    expect(user.depositBalance.currency?.code).toBe('EUR')
  })
})

describe('rowToInvoice / rowToBid', () => {
  it('maps invoice dates to ms and price', () => {
    const row: InvoiceRow = {
      id: 'inv-1',
      userId: 'u1',
      createdDate: D('2025-01-01T00:00:00Z'),
      invoiceCreatedDate: D('2025-01-01T00:00:00Z'),
      invoiceDueDate: D('2025-01-15T00:00:00Z'),
      paidAt: null,
      status: 'unpaid',
      priceAmount: '2500.00',
      priceCurrency: 'CZK',
      url: '#',
      fakturoidId: null,
      variableSymbol: null,
      iban: null,
      billingAddress: null,
      type: 'deposit',
      fakturoidPaidAt: null,
      stripeSessionId: null,
      stripePaymentIntent: null,
    }
    const inv = rowToInvoice(row)
    expect(inv.createdDate).toBe(D('2025-01-01T00:00:00Z').getTime())
    expect(inv.paidAt).toBeUndefined()
    expect(inv.price).toEqual({ amount: 2500, currency: { code: 'CZK', symbol: 'Kč', symbolBefore: false } })
  })

  it('maps bid amount string to number', () => {
    const bid = rowToBid({
      id: '9',
      itemId: 'i1',
      userId: 'b2',
      amount: '15200.00',
      currencyCode: 'EUR',
      date: D('2025-01-02T00:00:00Z'),
      avatarUrl: 'x',
    })
    expect(bid.amount).toBe(15200)
    expect(bid.avatarUrl).toBe('x')
  })
})

describe('model → insert builders', () => {
  it('userToInsert converts enum back to provider string and splits price/currency', () => {
    const ins = userToInsert(rowToUser(baseUserRow()))
    expect(ins.authType).toBe('email')
    expect(ins.languageCode).toBe('cz')
    expect(ins.depositBalanceAmount).toBe(5000)
    expect(ins.depositBalanceCurrency).toBe('EUR')
    expect(ins.roles).toEqual(['user', 'admin'])
  })

  it('itemToInsert converts ms dates to Date and enum type to string', () => {
    const item = rowToItem(baseItemRow(), [])
    const ins = itemToInsert(item)
    expect(ins.startDate).toBeInstanceOf(Date)
    expect((ins.startDate as Date).getTime()).toBe(D('2025-01-01T00:00:00Z').getTime())
    expect(ins.type).toBe('auction')
    expect(ins.priceFromAmount).toBe(28000)
    expect(ins.priceFromCurrency).toBe('EUR')
  })

  it('bidToInsert maps a Bid to row columns', () => {
    const ins = bidToInsert('i1', {
      userId: 'b1',
      date: D('2025-01-02T00:00:00Z').getTime(),
      amount: 100,
      currency: currencyByCode('EUR'),
    })
    expect(ins.itemId).toBe('i1')
    expect(ins.currencyCode).toBe('EUR')
    expect(ins.date).toBeInstanceOf(Date)
  })
})

describe('reference rehydration', () => {
  it('resolves currency and language by code with sensible fallbacks', () => {
    expect(currencyByCode('EUR')?.symbol).toBe('€')
    expect(currencyByCode('XXX')).toBeUndefined()
    expect(currencyByCode(null)).toBeUndefined()
    expect(languageByCode('en').code).toBe('en')
    expect(languageByCode(null).code).toBe('cz')
  })
})

describe('rowToContactMessage', () => {
  const baseRow = (over: Partial<ContactMessageRow> = {}): ContactMessageRow => ({
    id: 'c1',
    kind: 'contact',
    name: 'Jan',
    email: 'jan@example.com',
    phone: null,
    location: null,
    vehicle: null,
    message: 'Hi',
    itemId: null,
    userId: null,
    offerAmount: null,
    offerCurrency: null,
    status: 'new',
    notifiedAt: null,
    created: D('2025-01-01T00:00:00Z'),
    ...over,
  })

  it('maps a contact row: nulls → undefined, created → epoch-ms, no offer', () => {
    const m = rowToContactMessage(baseRow())
    expect(m.kind).toBe('contact')
    expect(m.name).toBe('Jan')
    expect(m.phone).toBeUndefined()
    expect(m.offer).toBeUndefined()
    expect(m.status).toBe('new')
    expect(m.notifiedAt).toBeUndefined()
    expect(m.created).toBe(D('2025-01-01T00:00:00Z').getTime())
  })

  it('rehydrates the offer Price and notifiedAt for an offer row', () => {
    const m = rowToContactMessage(
      baseRow({
        kind: 'offer',
        itemId: 'i9',
        userId: 'u9',
        offerAmount: '12500.00',
        offerCurrency: 'EUR',
        notifiedAt: D('2025-02-02T00:00:00Z'),
      }),
    )
    expect(m.kind).toBe('offer')
    expect(m.itemId).toBe('i9')
    expect(m.offer).toEqual({ amount: 12500, currency: currencyByCode('EUR') })
    expect(m.notifiedAt).toBe(D('2025-02-02T00:00:00Z').getTime())
  })
})
