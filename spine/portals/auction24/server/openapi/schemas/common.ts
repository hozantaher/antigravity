import { z } from 'zod'
import { registry } from '../registry'

export const CurrencySchema = registry.register(
  'Currency',
  z
    .object({
      code: z.string().openapi({ example: 'CZK' }),
      symbol: z.string().openapi({ example: 'Kč' }),
      symbolBefore: z.boolean().openapi({ example: false }),
    })
    .openapi('Currency'),
)

export const PriceSchema = registry.register(
  'Price',
  z
    .object({
      currency: CurrencySchema.optional(),
      amount: z.number().optional().openapi({ example: 250000 }),
      vat: z.number().optional().openapi({ example: 21 }),
    })
    .openapi('Price'),
)

export const LanguageSchema = registry.register(
  'Language',
  z
    .object({
      code: z.string().openapi({ example: 'cz' }),
      name: z.string().openapi({ example: 'Čeština' }),
      cs: z.string().openapi({ example: 'Čeština' }),
      en: z.string().openapi({ example: 'Czech' }),
    })
    .openapi('Language'),
)

export const CountrySchema = registry.register(
  'Country',
  z
    .object({
      code2: z.string().openapi({ example: 'CZ' }),
      code3: z.string().openapi({ example: 'CZE' }),
      phoneCode: z.string().openapi({ example: '+420' }),
      name: z.string().openapi({ example: 'Czech Republic' }),
      vat: z.number().openapi({ example: 21 }),
    })
    .openapi('Country'),
)

export const CategorySchema = registry.register(
  'Category',
  z
    .object({
      id: z.string().openapi({ example: 'cars' }),
      title: z.string().openapi({ example: 'Cars' }),
      image: z.string().openapi({ example: '/categories/cars.svg' }),
      active: z.boolean(),
      paramIds: z.array(z.number()).openapi({ example: [1, 2, 3] }),
    })
    .openapi('Category'),
)

export const CategoryParamSchema = registry.register(
  'CategoryParam',
  z
    .object({
      id: z.number().openapi({ example: 1 }),
      label: z.string().openapi({ example: 'Mileage' }),
      placeholder: z.string().optional(),
    })
    .openapi('CategoryParam'),
)

// Repos return this Paginated<T> shape from `paginate()` — wrap per item schema at the call site.
export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().openapi({ example: 42 }),
    page: z.number().openapi({ example: 1 }),
    pageSize: z.number().openapi({ example: 24 }),
  })

// Every request body / response in this API is single `application/json` — these collapse the
// repeated `content: { 'application/json': { schema } }` nesting at the call sites.
export const jsonBody = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } })
export const json = (schema: z.ZodTypeAny, description: string) => ({ description, ...jsonBody(schema) })
export const jsonPage = (item: z.ZodTypeAny, description: string) => json(paginated(item), description)

// Query params shared by every paginated endpoint (parsePageParams).
export const pageQuery = z.object({
  page: z.coerce.number().int().positive().optional().openapi({ example: 1 }),
  pageSize: z.coerce.number().int().positive().max(100).optional().openapi({ example: 24 }),
})

export const errorResponses = {
  400: { description: 'Invalid request' },
  401: { description: 'Authentication required' },
  403: { description: 'Insufficient permissions' },
  404: { description: 'Resource not found' },
  409: { description: 'Business logic conflict' },
  429: { description: 'Rate limited' },
  503: { description: 'Service not configured' },
} as const
