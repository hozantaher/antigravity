import type { Address } from './Address'
import type { Language } from './Language'
import type { Price } from './Price'

export interface User {
  id: string
  authType: AuthType
  fullName: string
  companyName?: string
  companyVatNumber?: string
  companyIdNumber?: string
  bankAccount?: string
  phone?: string
  email: string
  address?: Address
  vat?: number
  roles: UserRole[]
  depositBalance: Price
  fakturoidId?: number
  invoiceDueDays: number
  favoriteIds: string[]
  language: Language
  newsletter: boolean
  depositRequired?: boolean
  emailVerified?: boolean
}

export enum AuthType {
  anonymous,
  email,
  facebook,
  google,
}

export enum UserRole {
  user = 'user',
  admin = 'admin',
}

// The single "deposit satisfied" predicate — shared by the bid gates (client +
// server), the deposit endpoints' 409 guard, and the ItemBid redirect so the
// rule can't drift between copies.
export const hasDepositPaid = (user: Pick<User, 'depositRequired' | 'depositBalance'>): boolean =>
  !user.depositRequired || (user.depositBalance?.amount ?? 0) > 0

// A user may bid only with verified email + phone, and — when a deposit is
// required — a positive deposit balance. Shared by the client gate (useUser)
// and the server gate (bid endpoint) so both agree.
export const isUserEligibleToBid = (
  user: Pick<User, 'depositRequired' | 'depositBalance' | 'emailVerified' | 'phone'>,
): boolean => hasDepositPaid(user) && !!user.emailVerified && !!user.phone
