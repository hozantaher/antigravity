import { z } from 'zod'
import { registry } from '../registry'
import { PriceSchema } from './common'
import { FUEL_TYPES, TRANSMISSIONS, BODY_TYPES, DRIVE_TYPES, VEHICLE_COLORS } from '~/models'

export const ITEM_TYPES = ['auction', 'ad'] as const

export const VehicleSpecsSchema = registry.register(
  'VehicleSpecs',
  z
    .object({
      manufacturer: z.string().optional().openapi({ example: 'Volkswagen' }),
      model: z.string().optional().openapi({ example: 'Passat' }),
      yearOfManufacture: z.number().optional().openapi({ example: 2018 }),
      enginePowerHp: z.number().optional(),
      numberOfGears: z.number().optional(),
      emissionStandard: z.string().optional().openapi({ example: 'Euro 6' }),
      co2EmissionGkm: z.number().optional(),
      fuelConsumptionCombined: z.number().optional(),
      fuelConsumptionUrban: z.number().optional(),
      fuelConsumptionExtraUrban: z.number().optional(),
      numberOfDoors: z.number().optional(),
      numberOfSeats: z.number().optional(),
      numberOfAxles: z.number().optional(),
      numberOfAirbags: z.number().optional(),
      lengthMm: z.number().optional(),
      widthMm: z.number().optional(),
      heightMm: z.number().optional(),
      wheelbaseMm: z.number().optional(),
      weightEmptyKg: z.number().optional(),
      maxSpeedKmh: z.number().optional(),
      tyreSize: z.string().optional(),
    })
    .openapi('VehicleSpecs'),
)

export const BidSchema = registry.register(
  'Bid',
  PriceSchema.extend({
    userId: z.string(),
    date: z.number().openapi({ description: 'Epoch milliseconds', example: 1717000000000 }),
    avatarUrl: z.string().optional(),
  }).openapi('Bid'),
)

export const WinnerSchema = registry.register(
  'Winner',
  z.object({ id: z.string(), name: z.string() }).openapi('Winner'),
)

export const LiveItemSchema = registry.register(
  'LiveItem',
  z
    .object({
      id: z.string(),
      lastBid: BidSchema.optional().openapi({
        description: 'Newest bid; drives the current price. Absent when there are no bids yet.',
      }),
      bidCount: z.number().openapi({ example: 7 }),
      endDate: z.number().optional().openapi({ description: 'Epoch ms; may be soft-close-extended' }),
      sold: z.boolean(),
      closed: z.boolean(),
      winner: WinnerSchema.optional(),
    })
    .openapi('LiveItem'),
)

export const AdHighlightSchema = registry.register(
  'AdHighlight',
  z
    .object({
      paramId: z.number().optional(),
      title: z.string().openapi({ example: 'Mileage' }),
      value: z.string().openapi({ example: '120 000 km' }),
      placeholder: z.string().optional(),
    })
    .openapi('AdHighlight'),
)

export const GpsSchema = registry.register(
  'Gps',
  z.object({ lat: z.number(), lng: z.number(), address: z.string() }).openapi('Gps'),
)

export const ItemSchema = registry.register(
  'Item',
  z
    .object({
      id: z.string().openapi({ example: '4rSiIuqXL91In2oznztN' }),
      internalId: z.string().optional(),
      title: z.string().openapi({ example: 'JCB 3 CX / 2007' }),
      image: z.string().openapi({ description: 'Main image (Firebase Storage download URL)' }),
      images: z.array(z.string()),
      images360: z.array(z.string()),
      description: z.record(z.string(), z.string()).openapi({ description: 'Localized text keyed by locale code' }),
      highlights: z
        .record(z.string(), z.array(AdHighlightSchema))
        .openapi({ description: 'Highlights keyed by locale' }),
      minimalPrice: PriceSchema.optional(),
      priceFrom: PriceSchema.optional(),
      minBid: PriceSchema.optional(),
      categoryId: z.string().openapi({ example: 'cars' }),
      userId: z.string(),
      bids: z.array(BidSchema),
      location: z.string().optional(),
      countryCode: z.string().optional().openapi({ example: 'CZ' }),
      youtubeVideoId: z.string().optional(),
      priceHighlighted: z.boolean(),
      taxIncluded: z.boolean(),
      sold: z.boolean(),
      closed: z.boolean().openapi({ description: 'Whether the auction is closed' }),
      hidden: z.boolean(),
      winner: WinnerSchema.optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      startDate: z.number().optional().openapi({ description: 'Epoch milliseconds' }),
      endDate: z.number().optional().openapi({ description: 'Epoch milliseconds' }),
      type: z.enum(ITEM_TYPES),
      created: z.number().optional(),
      updated: z.number().optional(),
      visibleUpdated: z.number().optional(),
      gps: GpsSchema.optional(),
      vin: z.string().optional(),
      fuelType: z.enum(FUEL_TYPES).optional(),
      transmission: z.enum(TRANSMISSIONS).optional(),
      bodyType: z.enum(BODY_TYPES).optional(),
      driveType: z.enum(DRIVE_TYPES).optional(),
      enginePowerKw: z.number().optional(),
      engineDisplacementCcm: z.number().optional(),
      color: z.enum(VEHICLE_COLORS).optional(),
      firstRegistrationDate: z.string().optional().openapi({ example: '2018-03-01' }),
      specs: VehicleSpecsSchema.optional(),
    })
    .openapi('Item'),
)
