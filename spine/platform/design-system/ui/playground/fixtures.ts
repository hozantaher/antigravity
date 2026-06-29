import type { Bid, Currency, Gps, Invoice, Item, User } from '~/models'
import { AuthType, ItemType } from '~/models'

// Client-side mock data for the playground. Mirrors the FE contract the repo mappers
// produce: epoch-ms timestamps, Price/Currency as objects, enums as values.

export const czk: Currency = { code: 'CZK', symbol: 'Kč', symbolBefore: false }
export const eur: Currency = { code: 'EUR', symbol: '€', symbolBefore: true }

const now = Date.now()
const days = (n: number) => n * 86_400_000
const hours = (n: number) => n * 3_600_000

const img = (seed: string) => `https://picsum.photos/seed/${seed}/800/600`

export const mockGps: Gps = { address: 'Evropská 2758/11, Praha 6', lat: 50.0998, lng: 14.3946 }

// Oldest-first, matching the FE contract (itemRepo loads bids `date asc`); itemCurrentPrice
// reads the last element as the current/highest bid.
const liveBids: Bid[] = [
  { currency: czk, amount: 398_000, userId: 'b2', date: now - hours(20) },
  { currency: czk, amount: 405_000, userId: 'b1', date: now - hours(6) },
  { currency: czk, amount: 412_000, userId: 'b3', date: now - hours(2) },
]

// Newest-first list for the bid history specimens.
export const mockBids: Bid[] = [
  { currency: czk, amount: 412_000, userId: 'me', date: now - hours(2) },
  { currency: czk, amount: 405_000, userId: 'b1', date: now - hours(6) },
  { currency: czk, amount: 398_000, userId: 'b2', date: now - hours(20) },
  { currency: czk, amount: 390_000, userId: 'b3', date: now - days(1) },
]

const baseItem = (over: Partial<Item>): Item => ({
  id: 'i0',
  title: 'Škoda Octavia Combi 2.0 TDI',
  image: img('octavia'),
  images: [img('octavia'), img('octavia-2'), img('octavia-3')],
  images360: [],
  description: {
    cz: 'Servisní knížka, jeden majitel, koupeno v ČR. Pravidelný servis, nehavarováno.',
    en: 'Full service history, single owner, bought in CZ. Regularly serviced, no accidents.',
  },
  highlights: {
    cz: [
      { title: 'Stav', value: 'Ojeté' },
      { title: 'Najeto', value: '128 000 km' },
    ],
    en: [
      { title: 'Condition', value: 'Used' },
      { title: 'Mileage', value: '128,000 km' },
    ],
  },
  categoryId: 'cars',
  userId: 'u1',
  bids: [],
  priceHighlighted: false,
  taxIncluded: true,
  sold: false,
  closed: false,
  hidden: false,
  type: ItemType.auction,
  location: 'Praha',
  countryCode: 'cz',
  email: 'prodej@auction24.cz',
  phone: '+420 777 123 456',
  gps: mockGps,
  vin: 'TMBJJ7NE0J0123456',
  fuelType: 'diesel',
  transmission: 'automatic',
  bodyType: 'wagon',
  driveType: 'fwd',
  enginePowerKw: 110,
  engineDisplacementCcm: 1968,
  color: 'grey',
  firstRegistrationDate: '2019-03-01',
  specs: {
    manufacturer: 'Škoda',
    model: 'Octavia Combi',
    yearOfManufacture: 2019,
    enginePowerHp: 150,
    numberOfGears: 7,
    emissionStandard: 'Euro 6',
    co2EmissionGkm: 118,
    fuelConsumptionCombined: 4.5,
    numberOfDoors: 5,
    numberOfSeats: 5,
    maxSpeedKmh: 216,
  },
  ...over,
})

export const liveItem = baseItem({
  id: 'i-live',
  title: 'Škoda Octavia Combi 2.0 TDI',
  type: ItemType.auction,
  startDate: now - days(2),
  endDate: now + hours(20),
  priceFrom: { currency: czk, amount: 350_000 },
  minimalPrice: { currency: czk, amount: 420_000 },
  bids: liveBids,
  bidCount: 14,
})

export const soonItem = baseItem({
  id: 'i-soon',
  title: 'BMW 320d Touring xDrive',
  image: img('bmw'),
  images: [img('bmw')],
  type: ItemType.auction,
  startDate: now + days(2),
  endDate: now + days(5),
  priceFrom: { currency: czk, amount: 480_000 },
  specs: { manufacturer: 'BMW', model: '320d Touring', yearOfManufacture: 2021 },
})

export const endedItem = baseItem({
  id: 'i-ended',
  title: 'Audi A4 Avant 40 TDI',
  image: img('audi'),
  images: [img('audi')],
  type: ItemType.auction,
  startDate: now - days(7),
  endDate: now - days(1),
  closed: true,
  priceFrom: { currency: czk, amount: 520_000 },
  bids: [{ currency: czk, amount: 540_000, userId: 'b2', date: now - days(1) }],
})

export const processingItem = baseItem({
  id: 'i-proc',
  title: 'Volkswagen Passat 2.0 TDI',
  image: img('passat'),
  images: [img('passat')],
  type: ItemType.auction,
  startDate: now - days(5),
  endDate: now - hours(1),
  closed: false,
  priceFrom: { currency: eur, amount: 18_900 },
  bids: [{ currency: eur, amount: 19_500, userId: 'b1', date: now - hours(1) }],
})

export const buyNowItem = baseItem({
  id: 'i-buynow',
  title: 'Mercedes-Benz C 220 d',
  image: img('mercedes'),
  images: [img('mercedes')],
  type: ItemType.ad,
  priceFrom: { currency: eur, amount: 24_500 },
  specs: { manufacturer: 'Mercedes-Benz', model: 'C 220 d', yearOfManufacture: 2020 },
})

export const soldItem = baseItem({
  id: 'i-sold',
  title: 'Ford Focus Kombi 1.5 EcoBlue',
  image: img('ford'),
  images: [img('ford')],
  type: ItemType.auction,
  startDate: now - days(10),
  endDate: now - days(3),
  closed: true,
  sold: true,
  winner: { id: 'b4', name: 'Karel Novák' },
  priceFrom: { currency: czk, amount: 280_000 },
  bids: [{ currency: czk, amount: 305_000, userId: 'b4', date: now - days(3) }],
})

export const mockItems: Item[] = [liveItem, soonItem, processingItem, buyNowItem, endedItem, soldItem]

export const mockInvoices: Invoice[] = [
  {
    id: 'inv-1001',
    createdDate: now - days(30),
    invoiceCreatedDate: now - days(30),
    invoiceDueDate: now - days(16),
    paidAt: now - days(28),
    status: 'paid',
    price: { currency: czk, amount: 10_000 },
    url: '#',
    userId: 'u1',
  },
  {
    id: 'inv-1002',
    createdDate: now - days(4),
    invoiceCreatedDate: now - days(4),
    invoiceDueDate: now + days(10),
    status: 'unpaid',
    price: { currency: czk, amount: 10_000 },
    url: '#',
    userId: 'u1',
  },
  {
    id: 'inv-1003',
    createdDate: now - days(2),
    status: 'unpaid',
    price: { currency: eur, amount: 500 },
    url: '#',
    userId: 'u1',
  },
]

export const mockUser: User = {
  id: 'u1',
  authType: AuthType.email,
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+420 777 123 456',
  roles: [],
  depositBalance: { currency: czk, amount: 10_000 },
  invoiceDueDays: 14,
  favoriteIds: [],
  language: { code: 'cz', name: 'Čeština', cs: 'Čeština', en: 'Czech' },
  newsletter: false,
  emailVerified: true,
}
