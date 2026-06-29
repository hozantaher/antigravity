import type { Language } from './Language'
import type { Address, AuthType, Country, Price } from './index'

export interface RegisterDto {
  email: string
  password: string
  fullName?: string
  companyName: string
  companyVatNumber: string
  companyIdNumber: string
  phone?: string
  address?: Address
  type: AuthType
  country: Country
  depositBalance: Price
  language: Language
  newsletter: boolean
}
