// Vehicle parameters sourced from VIN decode (Vincario). The enum-typed fields below live as
// their own item columns (vin/fuelType/…); VehicleSpecs is the display-only long tail stored in a
// single `specs` JSONB column. This project keeps make/model/year in specs too — it has no
// dedicated columns for them.

export const FUEL_TYPES = ['petrol', 'diesel', 'electric', 'hybrid', 'phev', 'lpg', 'cng', 'hydrogen', 'other'] as const
export type FuelType = (typeof FUEL_TYPES)[number]

export const TRANSMISSIONS = ['manual', 'automatic', 'semi_automatic', 'cvt', 'dct'] as const
export type Transmission = (typeof TRANSMISSIONS)[number]

export const BODY_TYPES = [
  'sedan',
  'wagon',
  'hatchback',
  'suv',
  'coupe',
  'convertible',
  'van',
  'pickup',
  'minibus',
  'other',
] as const
export type BodyType = (typeof BODY_TYPES)[number]

export const DRIVE_TYPES = ['fwd', 'rwd', 'awd', '4x4'] as const
export type DriveType = (typeof DRIVE_TYPES)[number]

export const VEHICLE_COLORS = [
  'white',
  'black',
  'silver',
  'grey',
  'blue',
  'red',
  'green',
  'brown',
  'beige',
  'yellow',
  'orange',
  'gold',
  'other',
] as const
export type VehicleColor = (typeof VEHICLE_COLORS)[number]

// Display-only specs (JSONB). All optional — absent fields render no input/row.
export interface VehicleSpecs {
  manufacturer?: string
  model?: string
  yearOfManufacture?: number
  enginePowerHp?: number
  numberOfGears?: number
  emissionStandard?: string
  co2EmissionGkm?: number
  fuelConsumptionCombined?: number
  fuelConsumptionUrban?: number
  fuelConsumptionExtraUrban?: number
  numberOfDoors?: number
  numberOfSeats?: number
  numberOfAxles?: number
  numberOfAirbags?: number
  lengthMm?: number
  widthMm?: number
  heightMm?: number
  wheelbaseMm?: number
  weightEmptyKg?: number
  maxSpeedKmh?: number
  tyreSize?: string
}
