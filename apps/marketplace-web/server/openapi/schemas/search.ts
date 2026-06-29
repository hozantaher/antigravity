import { z } from 'zod'
import { registry } from '../registry'
import { ITEM_TYPES } from './items'
import { FUEL_TYPES, TRANSMISSIONS, BODY_TYPES, DRIVE_TYPES, VEHICLE_COLORS } from '~/models'

// Zod mirror of models/SearchQuery — the structured facet params layered onto the GET /api/search
// fulltext term. All optional (absent → ignored). Registered as a named component so the /api/search
// path can reference a single source of truth and a future saved-search body can reuse it. Docs-only
// (project uses zod for OpenAPI, not runtime validation).
export const SearchQuerySchema = registry.register(
  'SearchQuery',
  z
    .object({
      q: z.string().optional().openapi({ description: 'Diacritic-insensitive fulltext term', example: 'octavia' }),
      type: z.enum(ITEM_TYPES).optional().openapi({ description: 'Listing type' }),
      categoryId: z.string().optional().openapi({ example: 'cars' }),
      priceMin: z.coerce
        .number()
        .nonnegative()
        .optional()
        .openapi({ description: 'price_from_amount >=', example: 5000 }),
      priceMax: z.coerce
        .number()
        .nonnegative()
        .optional()
        .openapi({ description: 'price_from_amount <=', example: 20000 }),
      fuelType: z.enum(FUEL_TYPES).optional(),
      bodyType: z.enum(BODY_TYPES).optional(),
      transmission: z.enum(TRANSMISSIONS).optional(),
      driveType: z.enum(DRIVE_TYPES).optional(),
      color: z.enum(VEHICLE_COLORS).optional(),
      yearFrom: z.coerce
        .number()
        .int()
        .optional()
        .openapi({ description: 'first_registration_date year >=', example: 2015 }),
      yearTo: z.coerce
        .number()
        .int()
        .optional()
        .openapi({ description: 'first_registration_date year <=', example: 2022 }),
    })
    .openapi('SearchQuery'),
)
