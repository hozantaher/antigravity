import { z } from 'zod'
import { registry } from '../registry'
import { FUEL_TYPES, TRANSMISSIONS, BODY_TYPES, DRIVE_TYPES } from '~/models'

export const NormalizedVinSchema = registry.register(
  'NormalizedVin',
  z
    .object({
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      yearOfManufacture: z.number().optional(),
      fuelType: z.enum(FUEL_TYPES).optional(),
      transmission: z.enum(TRANSMISSIONS).optional(),
      bodyType: z.enum(BODY_TYPES).optional(),
      driveType: z.enum(DRIVE_TYPES).optional(),
      enginePowerKw: z.number().optional(),
      engineDisplacementCcm: z.number().optional(),
      enginePowerHp: z.number().optional(),
      numberOfGears: z.number().optional(),
      emissionStandard: z.string().optional(),
      co2EmissionGkm: z.number().optional(),
      numberOfDoors: z.number().optional(),
      numberOfSeats: z.number().optional(),
      numberOfAxles: z.number().optional(),
      lengthMm: z.number().optional(),
      widthMm: z.number().optional(),
      heightMm: z.number().optional(),
      wheelbaseMm: z.number().optional(),
      weightEmptyKg: z.number().optional(),
      maxSpeedKmh: z.number().optional(),
    })
    .openapi('NormalizedVin'),
)

export const DecodeVinRequestSchema = registry.register(
  'DecodeVinRequest',
  z.object({ vin: z.string().length(17).openapi({ example: 'WVWZZZ3CZJE000000' }) }).openapi('DecodeVinRequest'),
)

export const DecodeVinResponseSchema = registry.register(
  'DecodeVinResponse',
  z
    .object({
      vin: z.string(),
      normalized: NormalizedVinSchema,
      cached: z.boolean().openapi({ description: 'True when served from vin_decode_cache (no credit spent)' }),
      price: z.number().nullable(),
      priceCurrency: z.string().nullable(),
    })
    .openapi('DecodeVinResponse'),
)
