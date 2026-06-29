import type { FuelType, Transmission, BodyType, DriveType, VincarioDecodeItem, NormalizedVin } from '~/models'

const buildMap = (decode: VincarioDecodeItem[]): Map<string, string> => {
  const map = new Map<string, string>()
  for (const item of decode) {
    if (!item || typeof item.label !== 'string') continue
    const label = item.label.trim()
    const value = item.value == null ? '' : String(item.value).trim()
    if (label && value && !map.has(label)) map.set(label, value)
  }
  return map
}

const lookup = (map: Map<string, string>, ...labels: string[]): string | undefined => {
  for (const label of labels) {
    const v = map.get(label)
    if (v) return v
  }
  return undefined
}

// First integer run after dropping spaces and thousands separators. Vincario keeps the unit
// in the label ("Engine Displacement (ccm)"), but guard against the odd "1968 cm3" value too.
const toInt = (raw?: string): number | undefined => {
  if (!raw) return undefined
  const match = raw.replace(/[\s,]/g, '').match(/-?\d+/)
  if (!match) return undefined
  const n = Number.parseInt(match[0], 10)
  return Number.isFinite(n) ? n : undefined
}

export const normalizeFuel = (raw?: string): FuelType | undefined => {
  if (!raw) return undefined
  const s = raw.toLowerCase()
  if (s.includes('plug') || s.includes('phev')) return 'phev' // before 'hybrid' — "Plug-in Hybrid" matches both
  if (s.includes('hybrid')) return 'hybrid'
  if (s.includes('diesel')) return 'diesel'
  if (s.includes('petrol') || s.includes('gasoline') || s.includes('benzin') || s.includes('benzín')) return 'petrol'
  if (s.includes('hydrogen') || s.includes('fuel cell') || s.includes('fcev')) return 'hydrogen'
  if (s.includes('electric') || s === 'ev' || s === 'bev') return 'electric'
  if (s.includes('lpg') || s.includes('autogas') || s.includes('liquefied petroleum')) return 'lpg'
  if (s.includes('cng') || s.includes('natural gas') || s.includes('methane')) return 'cng'
  return 'other'
}

// No 'other' member → unrecognized transmissions stay blank rather than being mislabeled.
export const normalizeTransmission = (raw?: string): Transmission | undefined => {
  if (!raw) return undefined
  const s = raw.toLowerCase()
  if (
    s.includes('dct') ||
    s.includes('dual clutch') ||
    s.includes('dual-clutch') ||
    s.includes('dsg') ||
    s.includes('pdk')
  )
    return 'dct'
  if (s.includes('cvt') || s.includes('continuously variable')) return 'cvt'
  if (s.includes('semi') || s.includes('automated manual') || s.includes('amt') || s.includes('tiptronic'))
    return 'semi_automatic'
  if (s.includes('manual')) return 'manual'
  if (s.includes('automatic') || s.includes('auto')) return 'automatic'
  return undefined
}

export const normalizeBody = (raw?: string): BodyType | undefined => {
  if (!raw) return undefined
  const s = raw.toLowerCase()
  if (
    s.includes('suv') ||
    s.includes('sport utility') ||
    s.includes('crossover') ||
    s.includes('off-road') ||
    s.includes('offroad')
  )
    return 'suv'
  if (s.includes('pickup') || s.includes('pick-up') || s.includes('pick up')) return 'pickup'
  if (
    s.includes('convertible') ||
    s.includes('cabrio') ||
    s.includes('roadster') ||
    s.includes('spyder') ||
    s.includes('spider')
  )
    return 'convertible'
  if (s.includes('coupe') || s.includes('coupé')) return 'coupe'
  if (s.includes('hatchback') || s.includes('liftback') || s.includes('hatch')) return 'hatchback'
  if (
    s.includes('wagon') ||
    s.includes('estate') ||
    s.includes('touring') ||
    s.includes('combi') ||
    s.includes('kombi') ||
    s.includes('avant') ||
    s.includes('variant')
  )
    return 'wagon'
  if (
    s.includes('minibus') ||
    s.includes('mini bus') ||
    s.includes('minivan') ||
    s.includes('mpv') ||
    s.includes('bus')
  )
    return 'minibus'
  if (s.includes('van') || s.includes('panel')) return 'van'
  if (s.includes('sedan') || s.includes('saloon') || s.includes('notchback') || s.includes('limousine')) return 'sedan'
  return 'other'
}

// No 'other' member → unrecognized drivetrains stay blank.
export const normalizeDrive = (raw?: string): DriveType | undefined => {
  if (!raw) return undefined
  const s = raw.toLowerCase()
  if (s.includes('4x4') || s.includes('4wd') || s.includes('four-wheel') || s.includes('four wheel')) return '4x4'
  if (
    s.includes('all') ||
    s.includes('awd') ||
    s.includes('quattro') ||
    s.includes('4motion') ||
    s.includes('xdrive') ||
    s.includes('4matic') ||
    s.includes('integral')
  )
    return 'awd'
  if (s.includes('front') || s.includes('fwd')) return 'fwd'
  if (s.includes('rear') || s.includes('rwd')) return 'rwd'
  return undefined
}

export const normalizeVinDecode = (decode: VincarioDecodeItem[]): NormalizedVin => {
  const map = buildMap(decode)
  const out: NormalizedVin = {}

  const assignStr = (key: 'manufacturer' | 'model' | 'emissionStandard', ...labels: string[]) => {
    const v = lookup(map, ...labels)
    if (v) out[key] = v
  }
  const assignInt = (
    key:
      | 'yearOfManufacture'
      | 'enginePowerKw'
      | 'engineDisplacementCcm'
      | 'enginePowerHp'
      | 'numberOfGears'
      | 'co2EmissionGkm'
      | 'numberOfDoors'
      | 'numberOfSeats'
      | 'numberOfAxles'
      | 'lengthMm'
      | 'widthMm'
      | 'heightMm'
      | 'wheelbaseMm'
      | 'weightEmptyKg'
      | 'maxSpeedKmh',
    ...labels: string[]
  ) => {
    const v = toInt(lookup(map, ...labels))
    if (v != null) out[key] = v
  }

  assignStr('manufacturer', 'Make')
  assignStr('model', 'Model', 'Model Make')
  assignInt('yearOfManufacture', 'Model Year', 'Year')

  const fuel = normalizeFuel(lookup(map, 'Fuel Type - Primary', 'Fuel Type'))
  if (fuel) out.fuelType = fuel
  const transmission = normalizeTransmission(lookup(map, 'Transmission'))
  if (transmission) out.transmission = transmission
  const bodyType = normalizeBody(lookup(map, 'Body', 'Body Style', 'Vehicle Type', 'Product Type'))
  if (bodyType) out.bodyType = bodyType
  const driveType = normalizeDrive(lookup(map, 'Drive', 'Driven Wheels', 'Drive Type'))
  if (driveType) out.driveType = driveType

  assignInt('enginePowerKw', 'Engine Power (kW)', 'Engine Power')
  assignInt('engineDisplacementCcm', 'Engine Displacement (ccm)', 'Engine Displacement')
  assignInt('enginePowerHp', 'Engine Power (HP)', 'Engine Power (PS)')
  assignInt('numberOfGears', 'Number of Gears')
  assignStr('emissionStandard', 'Emission Standard')
  assignInt('co2EmissionGkm', 'Average CO2 Emission (g/km)', 'CO2 Emission (g/km)', 'CO2 Emission')
  assignInt('numberOfDoors', 'Number of Doors')
  assignInt('numberOfSeats', 'Number of Seats')
  assignInt('numberOfAxles', 'Number of Axles')
  assignInt('lengthMm', 'Length (mm)')
  assignInt('widthMm', 'Width (mm)')
  assignInt('heightMm', 'Height (mm)')
  assignInt('wheelbaseMm', 'Wheelbase (mm)')
  assignInt('weightEmptyKg', 'Weight Empty (kg)', 'Curb Weight (kg)')
  assignInt('maxSpeedKmh', 'Max Speed (km/h)', 'Maximum Speed (km/h)')

  return out
}

export const countNormalizedFields = (n: NormalizedVin): number =>
  Object.values(n).filter(v => v !== undefined && v !== '').length
