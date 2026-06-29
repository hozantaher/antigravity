import type { Item } from '~/models'

// schema.org Vehicle/Car structured data for an item listing. The marketplace also lists
// machinery/equipment that aren't road vehicles, so this returns null unless the item carries a
// vehicle signal — and only passenger-car bodies get the more specific `Car` type; everything else
// (trucks, vans, machinery) stays the generic `Vehicle`.

const FUEL_LABELS: Record<string, string> = {
  petrol: 'Gasoline',
  diesel: 'Diesel',
  electric: 'Electric',
  hybrid: 'Hybrid',
  phev: 'Plug-in Hybrid Electric',
  lpg: 'LPG',
  cng: 'CNG',
  hydrogen: 'Hydrogen',
}

const TRANSMISSION_LABELS: Record<string, string> = {
  manual: 'Manual',
  automatic: 'Automatic',
  semi_automatic: 'Semi-automatic',
  cvt: 'CVT',
  dct: 'Dual-clutch',
}

// schema.org DriveWheelConfigurationValue enumeration members.
const DRIVE_CONFIG: Record<string, string> = {
  fwd: 'FrontWheelDriveConfiguration',
  rwd: 'RearWheelDriveConfiguration',
  awd: 'AllWheelDriveConfiguration',
  '4x4': 'FourWheelDriveConfiguration',
}

const CAR_BODIES = new Set(['sedan', 'wagon', 'hatchback', 'suv', 'coupe', 'convertible'])

export interface VehicleLd {
  vehicleType: 'Car' | 'Vehicle'
  properties: Record<string, unknown>
}

export const buildVehicleLd = (item: Item): VehicleLd | null => {
  const s = item.specs
  const hasSignal =
    item.vin ||
    item.fuelType ||
    item.transmission ||
    item.bodyType ||
    item.driveType ||
    item.enginePowerKw ||
    item.engineDisplacementCcm ||
    s?.manufacturer ||
    s?.model
  if (!hasSignal) return null

  const properties: Record<string, unknown> = {}
  if (s?.manufacturer) properties.manufacturer = s.manufacturer
  if (s?.model) properties.model = s.model
  if (s?.yearOfManufacture) properties.vehicleModelDate = String(s.yearOfManufacture)
  if (item.firstRegistrationDate) properties.dateVehicleFirstRegistered = item.firstRegistrationDate
  if (item.fuelType) properties.fuelType = FUEL_LABELS[item.fuelType] ?? item.fuelType
  if (item.transmission) properties.vehicleTransmission = TRANSMISSION_LABELS[item.transmission] ?? item.transmission
  if (item.bodyType) properties.bodyType = item.bodyType
  if (item.driveType) properties.driveWheelConfiguration = DRIVE_CONFIG[item.driveType] ?? item.driveType
  if (item.color) properties.color = item.color
  if (item.vin) properties.vehicleIdentificationNumber = item.vin
  if (s?.numberOfDoors) properties.numberOfDoors = s.numberOfDoors
  if (s?.numberOfSeats) properties.vehicleSeatingCapacity = s.numberOfSeats

  const engine: Record<string, unknown> = {}
  if (item.enginePowerKw)
    engine.enginePower = { '@type': 'QuantitativeValue', value: item.enginePowerKw, unitCode: 'KWT' }
  if (item.engineDisplacementCcm)
    engine.engineDisplacement = { '@type': 'QuantitativeValue', value: item.engineDisplacementCcm, unitCode: 'CMQ' }
  if (Object.keys(engine).length) properties.vehicleEngine = { '@type': 'EngineSpecification', ...engine }

  const vehicleType = item.bodyType && CAR_BODIES.has(item.bodyType) ? 'Car' : 'Vehicle'
  return { vehicleType, properties }
}
