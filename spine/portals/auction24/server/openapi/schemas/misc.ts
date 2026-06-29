import { z } from 'zod'
import { registry } from '../registry'
import { PriceSchema } from './common'
import { RegisterProfileSchema } from './users'

export const LoginRequestSchema = registry.register(
  'LoginRequest',
  z
    .object({
      idToken: z.string().openapi({ description: 'Firebase ID token from the client SDK' }),
      profile: RegisterProfileSchema.optional().openapi({ description: 'Sign-up profile, applied on first login' }),
    })
    .openapi('LoginRequest'),
)

export const PlaceBidRequestSchema = registry.register(
  'PlaceBidRequest',
  z.object({ amount: z.number().positive().openapi({ example: 260000 }) }).openapi('PlaceBidRequest'),
)

// Covers both shapes the endpoint accepts: a general contact-form message (name/email/…)
// and a price offer on a listing (type: 'offer' + itemId + price). The offer's user is
// taken from the session, never from the body.
export const ContactRequestSchema = registry.register(
  'ContactRequest',
  z
    .object({
      type: z
        .literal('offer')
        .optional()
        .openapi({ description: "Set to 'offer' for a price offer on a listing; omit for a contact message." }),
      name: z.string().optional().openapi({ example: 'Jan Novák' }),
      email: z.string().optional().openapi({ example: 'jan@example.com' }),
      phone: z.string().optional(),
      location: z.string().optional().openapi({ description: 'Vehicle location (contact form).' }),
      vehicle: z.string().optional().openapi({ description: 'What the sender wants to sell (contact form).' }),
      message: z.string().optional().openapi({ example: 'I am interested in this vehicle.' }),
      itemId: z.string().optional().openapi({ description: 'Listing id the offer is for (offer).' }),
      price: PriceSchema.optional().openapi({ description: 'Offered price (offer).' }),
    })
    .openapi('ContactRequest'),
)

export const ContactMessageSchema = registry.register(
  'ContactMessage',
  z
    .object({
      id: z.string(),
      kind: z.enum(['contact', 'offer']),
      name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      location: z.string().optional(),
      vehicle: z.string().optional(),
      message: z.string().optional(),
      itemId: z.string().optional(),
      userId: z.string().optional(),
      offer: PriceSchema.optional(),
      status: z.enum(['new', 'read', 'archived']),
      notifiedAt: z.number().optional().openapi({ description: 'Epoch-ms the ops notification was enqueued.' }),
      created: z.number().openapi({ description: 'Epoch-ms.' }),
    })
    .openapi('ContactMessage'),
)

export const TranslateRequestSchema = registry.register(
  'TranslateRequest',
  z
    .object({
      text: z
        .union([z.string(), z.array(z.string())])
        .openapi({ description: 'Text(s) to translate', example: ['Diesel'] }),
      code: z.string().openapi({ description: 'Target locale code', example: 'de' }),
      sourceCode: z.string().optional().openapi({ description: 'Source DeepL language code', example: 'CS' }),
    })
    .openapi('TranslateRequest'),
)

export const TranslateResponseSchema = registry.register(
  'TranslateResponse',
  z.object({ texts: z.array(z.string()) }).openapi('TranslateResponse'),
)

export const PasswordResetRequestSchema = registry.register(
  'PasswordResetRequest',
  z
    .object({
      email: z.string().openapi({ example: 'jan@example.com' }),
      locale: z.string().optional().openapi({ example: 'cz' }),
    })
    .openapi('PasswordResetRequest'),
)

export const FavoriteToggleRequestSchema = registry.register(
  'FavoriteToggleRequest',
  z.object({ id: z.string().openapi({ description: 'Item id to toggle' }) }).openapi('FavoriteToggleRequest'),
)

export const UploadResponseSchema = registry.register(
  'UploadResponse',
  z
    .object({
      url: z.string().openapi({ description: 'Tokenized Firebase Storage download URL' }),
      objectPath: z.string().openapi({ example: 'public/ads/{itemId}/{uuid}.jpg' }),
    })
    .openapi('UploadResponse'),
)
