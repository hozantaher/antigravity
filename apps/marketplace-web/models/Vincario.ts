import type { FuelType, Transmission, BodyType, DriveType } from './VehicleSpecs'

export interface VincarioDecodeItem {
  label: string
  value: string | number
  id?: number
}

export interface VincarioDecodeResponse {
  decode: VincarioDecodeItem[]
  price?: number
  price_currency?: string
  balance?: Record<string, unknown>
}

// VIN-decodable fields mapped onto the project's enums. The enum/int fields become item columns;
// manufacturer/model/yearOfManufacture and the long tail go into item.specs. color and
// firstRegistrationDate are intentionally absent — a VIN does not encode them.
export interface NormalizedVin {
  manufacturer?: string
  model?: string
  yearOfManufacture?: number
  fuelType?: FuelType
  transmission?: Transmission
  bodyType?: BodyType
  driveType?: DriveType
  enginePowerKw?: number
  engineDisplacementCcm?: number
  enginePowerHp?: number
  numberOfGears?: number
  emissionStandard?: string
  co2EmissionGkm?: number
  numberOfDoors?: number
  numberOfSeats?: number
  numberOfAxles?: number
  lengthMm?: number
  widthMm?: number
  heightMm?: number
  wheelbaseMm?: number
  weightEmptyKg?: number
  maxSpeedKmh?: number
}

export interface DecodeVinResponse {
  vin: string
  normalized: NormalizedVin
  cached: boolean
  price: number | null
  priceCurrency: string | null
}
