import type { Category, CategoryParam, Country, Currency, Invoice, Item, Language, User } from '~/models'
// Relative (not ~) so tsx-run scripts (db:migrate, seed:dev) can resolve the enum values.
import { AuthType, ItemType, UserRole } from '../../models'

// ---- Reference data ------------------------------------------------------

export const EUR: Currency = { code: 'EUR', symbol: '€', symbolBefore: false }
export const CZK: Currency = { code: 'CZK', symbol: 'Kč', symbolBefore: false }

export const currencies: Currency[] = [EUR, CZK]

export const countries: Country[] = [
  { code2: 'cz', code3: 'cze', phoneCode: '+420', name: 'Česká republika', vat: 21 },
  { code2: 'de', code3: 'deu', phoneCode: '+49', name: 'Deutschland', vat: 19 },
  { code2: 'pl', code3: 'pol', phoneCode: '+48', name: 'Polska', vat: 23 },
  { code2: 'sk', code3: 'svk', phoneCode: '+421', name: 'Slovensko', vat: 20 },
  { code2: 'at', code3: 'aut', phoneCode: '+43', name: 'Österreich', vat: 20 },
  { code2: 'nl', code3: 'nld', phoneCode: '+31', name: 'Nederland', vat: 21 },
  { code2: 'fr', code3: 'fra', phoneCode: '+33', name: 'France', vat: 20 },
]

export const languages: Language[] = [
  { code: 'cz', name: 'Čeština', cs: 'Čeština', en: 'Czech' },
  { code: 'en', name: 'English', cs: 'Angličtina', en: 'English' },
  { code: 'de', name: 'Deutsch', cs: 'Němčina', en: 'German' },
  { code: 'fr', name: 'Français', cs: 'Francouzština', en: 'French' },
  { code: 'pl', name: 'Polski', cs: 'Polština', en: 'Polish' },
  { code: 'nl', name: 'Nederlands', cs: 'Nizozemština', en: 'Dutch' },
  { code: 'ru', name: 'Русский', cs: 'Ruština', en: 'Russian' },
  { code: 'ua', name: 'Українська', cs: 'Ukrajinština', en: 'Ukrainian' },
  { code: 'hr', name: 'Hrvatski', cs: 'Chorvatština', en: 'Croatian' },
  { code: 'rs', name: 'Српски', cs: 'Srbština', en: 'Serbian' },
  { code: 'me', name: 'Crnogorski', cs: 'Černohorština', en: 'Montenegrin' },
  { code: 'ar', name: 'العربية', cs: 'Arabština', en: 'Arabic' },
]

// Category ids match both the SVG icon filename (/categories/<id>.svg) and the
// i18n key `<id>Category` used by CategoriesGrid.
const CATEGORY_IDS = ['car', 'moto', 'motorhome', 'vut75', 'to75', 'av', 'stt', 't', 'st', 'cm', 'bus', 'ft', 'others']

export const categories: Category[] = CATEGORY_IDS.map(id => ({
  id,
  title: id,
  image: `/category-icons/${id}.svg`,
  active: true,
  paramIds: [1, 2, 3, 4, 5],
}))

export const categoryParams: CategoryParam[] = [
  { id: 1, label: 'Rok výroby', placeholder: '2019' },
  { id: 2, label: 'Najeto', placeholder: '120 000 km' },
  { id: 3, label: 'Výkon', placeholder: '110 kW' },
  { id: 4, label: 'Palivo', placeholder: 'Diesel' },
  { id: 5, label: 'Převodovka', placeholder: 'Manuální' },
  { id: 6, label: 'VIN', placeholder: 'WDB...' },
  { id: 7, label: 'Hmotnost', placeholder: '7 500 kg' },
  { id: 8, label: 'Barva', placeholder: 'Bílá' },
]

// ---- Users ---------------------------------------------------------------

export const buildUsers = (): User[] => [
  {
    id: 'u1',
    authType: AuthType.email,
    fullName: 'Jan Novák',
    email: 'jan@auction24.cz',
    phone: '+420 777 123 456',
    roles: [UserRole.user],
    depositBalance: { amount: 5000, currency: EUR },
    invoiceDueDays: 14,
    favoriteIds: ['i2', 'i7'],
    language: languages[0]!,
    newsletter: true,
    emailVerified: true,
    vat: 21,
    companyName: 'Novák Trucks s.r.o.',
    companyVatNumber: 'CZ12345678',
    companyIdNumber: '12345678',
    bankAccount: '123456789/0800',
    depositRequired: false,
    address: { address: 'Na strži 1702/65', city: 'Praha 4', zip: '140 00', country: countries[0]! },
  },
  {
    id: 'admin1',
    authType: AuthType.email,
    fullName: 'Admin Auction',
    email: 'admin@auction24.cz',
    phone: '+420 777 000 000',
    roles: [UserRole.admin, UserRole.user],
    depositBalance: { amount: 100000, currency: EUR },
    invoiceDueDays: 14,
    favoriteIds: [],
    language: languages[0]!,
    newsletter: false,
    emailVerified: true,
  },
]

// ---- Items ---------------------------------------------------------------

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const hl = (cz: [string, string][], en: [string, string][]) => ({
  cz: cz.map(([title, value]) => ({ title, value })),
  en: en.map(([title, value]) => ({ title, value })),
})

const descFor = (cz: string, en: string) => ({ cz, en })

export const buildItems = (): Item[] => {
  const now = Date.now()

  const base = (o: Partial<Item> & { id: string; categoryId: string; title: string }): Item => ({
    internalId: o.id.toUpperCase(),
    image: `https://picsum.photos/seed/${o.id}-1/800/600`,
    images: [1, 2, 3, 4, 5].map(n => `https://picsum.photos/seed/${o.id}-${n}/1280/860`),
    images360: [],
    description: descFor(
      'Vozidlo v perfektním technickém stavu, pravidelný servis, kompletní servisní historie. K dispozici ihned.',
      'Vehicle in perfect technical condition, regular service, full service history. Available immediately.',
    ),
    highlights: hl(
      [
        ['Rok výroby', '2019'],
        ['Najeto', '184 000 km'],
        ['Výkon', '300 kW'],
        ['Palivo', 'Diesel'],
        ['Převodovka', 'Automatická'],
      ],
      [
        ['Year', '2019'],
        ['Mileage', '184,000 km'],
        ['Power', '300 kW'],
        ['Fuel', 'Diesel'],
        ['Transmission', 'Automatic'],
      ],
    ),
    priceFrom: { amount: 12000, currency: EUR },
    minimalPrice: { amount: 15000, currency: EUR },
    minBid: { amount: 500, currency: EUR },
    userId: 'admin1',
    bids: [],
    location: 'Praha',
    countryCode: 'cz',
    email: 'prodej@auction24.cz',
    phone: '+420 212 246 451',
    priceHighlighted: false,
    taxIncluded: false,
    sold: false,
    closed: false,
    hidden: false,
    type: ItemType.auction,
    created: now - 10 * DAY,
    updated: now - 2 * DAY,
    visibleUpdated: now - 2 * DAY,
    gps: { lat: 50.0598, lng: 14.4329, address: 'Praha, Na strži 1702/65' },
    ...o,
  })

  const bids = (itemId: string, currency: Currency, amounts: number[], firstAt: number, stepMs: number) =>
    amounts.map((amount, i) => ({
      amount,
      currency,
      userId: i === amounts.length - 1 ? 'u1' : `b${(i % 4) + 1}`,
      date: firstAt + i * stepMs,
    }))

  return [
    base({
      id: 'i1',
      categoryId: 'car',
      title: 'Mercedes-Benz S 500 4MATIC',
      type: ItemType.auction,
      startDate: now - 2 * DAY,
      endDate: now + 2 * HOUR,
      priceFrom: { amount: 28000, currency: EUR },
      minimalPrice: { amount: 32000, currency: EUR },
      bids: bids('i1', EUR, [28000, 29000, 30500, 31000], now - 6 * HOUR, 80 * 60 * 1000),
      priceHighlighted: true,
    }),
    base({
      id: 'i2',
      categoryId: 'moto',
      title: 'BMW R 1250 GS Adventure',
      type: ItemType.auction,
      startDate: now - 1 * DAY,
      endDate: now + 1 * DAY,
      location: 'Brno',
      priceFrom: { amount: 14000, currency: EUR },
      minimalPrice: { amount: 16000, currency: EUR },
      bids: bids('i2', EUR, [14000, 14500, 15200], now - 10 * HOUR, 3 * HOUR),
    }),
    base({
      id: 'i3',
      categoryId: 'bus',
      title: 'Setra S 515 HD',
      type: ItemType.auction,
      startDate: now - 6 * HOUR,
      endDate: now + 3 * DAY,
      location: 'Ostrava',
      countryCode: 'cz',
      priceFrom: { amount: 95000, currency: EUR },
      minimalPrice: { amount: 110000, currency: EUR },
      bids: [],
    }),
    base({
      id: 'i4',
      categoryId: 'cm',
      title: 'Caterpillar 320 GC',
      type: ItemType.ad,
      priceFrom: { amount: 89000, currency: EUR },
      minimalPrice: undefined,
      location: 'Plzeň',
      priceHighlighted: true,
    }),
    base({
      id: 'i5',
      categoryId: 'to75',
      title: 'Volvo FH 500 Globetrotter',
      type: ItemType.ad,
      priceFrom: { amount: 42000, currency: EUR },
      minimalPrice: undefined,
      location: 'Hradec Králové',
      countryCode: 'de',
    }),
    base({
      id: 'i6',
      categoryId: 'av',
      title: 'John Deere 6155R',
      type: ItemType.auction,
      startDate: now + 2 * DAY,
      endDate: now + 5 * DAY,
      location: 'České Budějovice',
      priceFrom: { amount: 78000, currency: EUR },
      minimalPrice: { amount: 85000, currency: EUR },
      bids: [],
    }),
    base({
      id: 'i7',
      categoryId: 'stt',
      title: 'Scania R 450 Highline',
      type: ItemType.auction,
      startDate: now - 1 * DAY,
      endDate: now + 5 * HOUR,
      location: 'Praha',
      priceFrom: { amount: 36000, currency: EUR },
      minimalPrice: { amount: 40000, currency: EUR },
      bids: bids('i7', EUR, [36000, 37000, 38500, 39000, 39500], now - 8 * HOUR, 90 * 60 * 1000),
    }),
    base({
      id: 'i8',
      categoryId: 'motorhome',
      title: 'Knaus Van TI Plus 650 MEG',
      type: ItemType.ad,
      priceFrom: { amount: 64000, currency: EUR },
      minimalPrice: undefined,
      location: 'Liberec',
    }),
    base({
      id: 'i9',
      categoryId: 't',
      title: 'Schwarzmüller SPA 3/E',
      type: ItemType.auction,
      startDate: now - 4 * DAY,
      endDate: now - 2 * HOUR,
      closed: false,
      location: 'Olomouc',
      priceFrom: { amount: 18000, currency: EUR },
      minimalPrice: { amount: 20000, currency: EUR },
      bids: bids('i9', EUR, [18000, 18500, 19000], now - 3 * DAY, 12 * HOUR),
    }),
    base({
      id: 'i10',
      categoryId: 'st',
      title: 'Krone SD Profi Liner',
      type: ItemType.auction,
      startDate: now - 8 * DAY,
      endDate: now - 4 * DAY,
      sold: true,
      closed: true,
      winner: { id: 'u1', name: 'Jan Novák' },
      location: 'Zlín',
      priceFrom: { amount: 12000, currency: EUR },
      bids: bids('i10', EUR, [12000, 12500, 13200], now - 7 * DAY, 1 * DAY),
    }),
    base({
      id: 'i11',
      categoryId: 'ft',
      title: 'Linde H30T Forklift',
      type: ItemType.ad,
      priceFrom: { amount: 11500, currency: EUR },
      minimalPrice: undefined,
      location: 'Pardubice',
    }),
    base({
      id: 'i12',
      categoryId: 'vut75',
      title: 'Mercedes-Benz Sprinter 316 CDI',
      type: ItemType.auction,
      startDate: now - 12 * HOUR,
      endDate: now + 8 * HOUR,
      location: 'Praha',
      priceFrom: { amount: 21000, currency: EUR },
      minimalPrice: { amount: 23000, currency: EUR },
      bids: bids('i12', EUR, [21000, 21500], now - 5 * HOUR, 2 * HOUR),
    }),
    base({
      id: 'i13',
      categoryId: 'others',
      title: 'Bobcat S550 Skid-Steer',
      type: ItemType.auction,
      startDate: now - 10 * DAY,
      endDate: now - 6 * DAY,
      sold: true,
      closed: true,
      winner: { id: 'b2', name: 'P. Dvořák' },
      location: 'Brno',
      priceFrom: { amount: 22000, currency: EUR },
      bids: bids('i13', EUR, [22000, 23000], now - 9 * DAY, 1 * DAY),
    }),
    base({
      id: 'i14',
      categoryId: 'car',
      title: 'Audi Q7 50 TDI quattro',
      type: ItemType.ad,
      priceFrom: { amount: 47000, currency: EUR },
      minimalPrice: undefined,
      location: 'Praha',
      priceHighlighted: true,
    }),
    base({
      id: 'i15',
      categoryId: 'moto',
      title: 'Ducati Multistrada V4 S',
      type: ItemType.auction,
      startDate: now + 1 * DAY,
      endDate: now + 4 * DAY,
      location: 'Brno',
      priceFrom: { amount: 17000, currency: EUR },
      minimalPrice: { amount: 19000, currency: EUR },
      bids: [],
    }),
    base({
      id: 'i16',
      categoryId: 'cm',
      title: 'JCB 3CX Backhoe Loader',
      type: ItemType.auction,
      startDate: now - 18 * HOUR,
      endDate: now + 12 * HOUR,
      location: 'Ústí nad Labem',
      priceFrom: { amount: 33000, currency: EUR },
      minimalPrice: { amount: 36000, currency: EUR },
      bids: bids('i16', EUR, [33000, 34000, 34500], now - 9 * HOUR, 3 * HOUR),
    }),
  ]
}

export const buildInvoices = (): Invoice[] => {
  const now = Date.now()
  return [
    {
      id: 'inv-1001',
      createdDate: now - 30 * DAY,
      invoiceCreatedDate: now - 30 * DAY,
      invoiceDueDate: now - 16 * DAY,
      paidAt: now - 20 * DAY,
      status: 'paid',
      price: { amount: 5000, currency: EUR },
      url: '#',
      userId: 'u1',
    },
    {
      id: 'inv-1002',
      createdDate: now - 3 * DAY,
      invoiceCreatedDate: now - 3 * DAY,
      invoiceDueDate: now + 11 * DAY,
      status: 'unpaid',
      price: { amount: 2500, currency: EUR },
      url: '#',
      userId: 'u1',
    },
  ]
}
