import type { Country } from './Country'

export interface Address {
  address: string
  city: string
  zip: string
  country: Country
}
