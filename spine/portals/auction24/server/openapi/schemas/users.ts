import { z } from 'zod'
import { registry } from '../registry'
import { PriceSchema, CountrySchema, LanguageSchema } from './common'

export const AddressSchema = registry.register(
  'Address',
  z
    .object({
      address: z.string().openapi({ example: 'Václavské náměstí 1' }),
      city: z.string().openapi({ example: 'Praha' }),
      zip: z.string().openapi({ example: '11000' }),
      country: CountrySchema,
    })
    .openapi('Address'),
)

export const UserSchema = registry.register(
  'User',
  z
    .object({
      id: z.string(),
      authType: z.number().openapi({ description: '0=anonymous, 1=email, 2=facebook, 3=google', example: 1 }),
      fullName: z.string().openapi({ example: 'Jan Novák' }),
      companyName: z.string().optional(),
      companyVatNumber: z.string().optional(),
      companyIdNumber: z.string().optional(),
      bankAccount: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().openapi({ example: 'jan@example.com' }),
      address: AddressSchema.optional(),
      vat: z.number().optional(),
      roles: z.array(z.enum(['user', 'admin'])).openapi({ example: ['user'] }),
      depositBalance: PriceSchema,
      fakturoidId: z.number().optional(),
      invoiceDueDays: z.number().openapi({ example: 14 }),
      favoriteIds: z.array(z.string()),
      language: LanguageSchema,
      newsletter: z.boolean(),
      depositRequired: z.boolean().optional(),
      emailVerified: z.boolean().optional(),
    })
    .openapi('User'),
)

// Profile fields accepted by PUT /api/me and POST /api/auth/login (body.profile).
export const RegisterProfileSchema = registry.register(
  'RegisterProfile',
  z
    .object({
      fullName: z.string().optional(),
      phone: z.string().optional(),
      language: LanguageSchema.optional(),
      newsletter: z.boolean().optional(),
      companyName: z.string().optional(),
      companyVatNumber: z.string().optional(),
      companyIdNumber: z.string().optional(),
      address: AddressSchema.optional(),
    })
    .openapi('RegisterProfile'),
)

export const InvoiceSchema = registry.register(
  'Invoice',
  z
    .object({
      id: z.string(),
      createdDate: z.number().optional(),
      invoiceCreatedDate: z.number().optional(),
      invoiceDueDate: z.number().optional(),
      paidAt: z.number().optional(),
      status: z.string().openapi({ example: 'paid' }),
      price: PriceSchema.optional(),
      url: z.string().optional(),
      userId: z.string(),
    })
    .openapi('Invoice'),
)
