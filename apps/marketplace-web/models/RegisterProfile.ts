import type { Address } from './Address'
import type { Language } from './Language'

// Shared registration-profile contract: the optional fields carried from the
// sign-up form (client RegisterPayload) to the server upsert (createOrGetUser).
export interface RegisterProfile {
  fullName?: string
  phone?: string
  language?: Language
  newsletter?: boolean
  companyName?: string
  companyVatNumber?: string
  companyIdNumber?: string
  address?: Address
}
