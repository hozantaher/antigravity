import { describe, it, expect } from 'vitest'
import { vincarioControlSum } from '~/server/utils/vincario'
import {
  normalizeVinDecode,
  countNormalizedFields,
  normalizeFuel,
  normalizeTransmission,
  normalizeBody,
  normalizeDrive,
} from '~/server/utils/vincarioNormalize'
import type { VincarioDecodeItem } from '~/models'

describe('vincarioControlSum', () => {
  it('is the first 10 chars of sha1("VIN|decode|key|secret")', () => {
    expect(vincarioControlSum('WAUZZZ8K9AA123456', 'abc', 'xyz')).toBe('1fcc6fcbae')
  })

  it('uppercases the VIN before hashing', () => {
    expect(vincarioControlSum('wauzzz8k9aa123456', 'abc', 'xyz')).toBe(
      vincarioControlSum('WAUZZZ8K9AA123456', 'abc', 'xyz'),
    )
  })

  it('depends on the secret key', () => {
    expect(vincarioControlSum('JTDBR32E720123456', 'k', 's1')).not.toBe(
      vincarioControlSum('JTDBR32E720123456', 'k', 's2'),
    )
  })

  it('returns 10 lowercase hex chars', () => {
    expect(vincarioControlSum('JTDBR32E720123456', 'k', 's')).toMatch(/^[0-9a-f]{10}$/)
  })
})

describe('normalizeVinDecode', () => {
  const decode: VincarioDecodeItem[] = [
    { label: 'Make', value: 'Audi' },
    { label: 'Model', value: 'A4' },
    { label: 'Model Year', value: 2015 },
    { label: 'Body', value: 'Sedan/Saloon' },
    { label: 'Fuel Type - Primary', value: 'Diesel' },
    { label: 'Transmission', value: 'Automatic' },
    { label: 'Drive', value: 'All wheel drive' },
    { label: 'Engine Power (kW)', value: '110' },
    { label: 'Engine Displacement (ccm)', value: '1,968' },
    { label: 'Length (mm)', value: '4 726' },
    { label: 'Number of Seats', value: 5 },
  ]

  it('maps labels onto the project enums and fields', () => {
    const n = normalizeVinDecode(decode)
    expect(n).toMatchObject({
      manufacturer: 'Audi',
      model: 'A4',
      yearOfManufacture: 2015,
      bodyType: 'sedan',
      fuelType: 'diesel',
      transmission: 'automatic',
      driveType: 'awd',
      enginePowerKw: 110,
      numberOfSeats: 5,
    })
  })

  it('strips thousands separators and spaces from integers', () => {
    const n = normalizeVinDecode(decode)
    expect(n.engineDisplacementCcm).toBe(1968)
    expect(n.lengthMm).toBe(4726)
  })

  it('omits absent fields and counts what was filled', () => {
    // NormalizedVin has no color / firstRegistrationDate by design — a VIN does not encode them.
    const n = normalizeVinDecode(decode)
    expect(n.enginePowerHp).toBeUndefined()
    expect(n.co2EmissionGkm).toBeUndefined()
    expect(countNormalizedFields(n)).toBeGreaterThan(0)
    expect(countNormalizedFields({})).toBe(0)
  })

  it('leaves an unknown transmission blank rather than mislabeling it', () => {
    const n = normalizeVinDecode([{ label: 'Transmission', value: 'Warp drive' }])
    expect(n.transmission).toBeUndefined()
  })

  it('returns an empty object for an empty decode array', () => {
    expect(normalizeVinDecode([])).toEqual({})
  })

  it('skips malformed entries: null items, non-string labels, empty label/value', () => {
    const messy = [
      null,
      undefined,
      { label: 123, value: 'x' },
      { label: '   ', value: 'ignored' },
      { label: 'Make', value: '   ' },
      { label: 'Model', value: null },
    ] as unknown as VincarioDecodeItem[]
    const n = normalizeVinDecode(messy)
    expect(n.manufacturer).toBeUndefined()
    expect(n.model).toBeUndefined()
    expect(n).toEqual({})
  })

  it('keeps the first occurrence of a duplicated label', () => {
    const n = normalizeVinDecode([
      { label: 'Make', value: 'Audi' },
      { label: 'Make', value: 'BMW' },
    ])
    expect(n.manufacturer).toBe('Audi')
  })

  it('falls back to alternate labels when the primary label is missing', () => {
    const n = normalizeVinDecode([
      { label: 'Model Make', value: 'Golf' },
      { label: 'Year', value: 2020 },
      { label: 'Body Style', value: 'Coupe' },
      { label: 'Driven Wheels', value: 'Front wheel drive' },
      { label: 'Fuel Type', value: 'Petrol' },
      { label: 'Engine Power', value: '85 kW' },
      { label: 'Engine Displacement', value: '1395' },
      { label: 'Engine Power (PS)', value: '116' },
      { label: 'CO2 Emission', value: '120' },
      { label: 'Curb Weight (kg)', value: '1300' },
      { label: 'Maximum Speed (km/h)', value: '200' },
    ])
    expect(n).toMatchObject({
      model: 'Golf',
      yearOfManufacture: 2020,
      bodyType: 'coupe',
      driveType: 'fwd',
      fuelType: 'petrol',
      enginePowerKw: 85,
      engineDisplacementCcm: 1395,
      enginePowerHp: 116,
      co2EmissionGkm: 120,
      weightEmptyKg: 1300,
      maxSpeedKmh: 200,
    })
  })

  it('fills the full long-tail of integer fields', () => {
    const n = normalizeVinDecode([
      { label: 'Number of Gears', value: '6' },
      { label: 'Number of Doors', value: '4' },
      { label: 'Number of Axles', value: '2' },
      { label: 'Width (mm)', value: '1 800' },
      { label: 'Height (mm)', value: '1430' },
      { label: 'Wheelbase (mm)', value: '2 800' },
      { label: 'Emission Standard', value: 'Euro 6' },
    ])
    expect(n).toMatchObject({
      numberOfGears: 6,
      numberOfDoors: 4,
      numberOfAxles: 2,
      widthMm: 1800,
      heightMm: 1430,
      wheelbaseMm: 2800,
      emissionStandard: 'Euro 6',
    })
  })

  it('parses an integer even with a trailing unit ("1968 cm3")', () => {
    const n = normalizeVinDecode([{ label: 'Engine Displacement (ccm)', value: '1968 cm3' }])
    expect(n.engineDisplacementCcm).toBe(1968)
  })

  it('ignores integer fields whose value has no digits', () => {
    const n = normalizeVinDecode([{ label: 'Number of Seats', value: 'n/a' }])
    expect(n.numberOfSeats).toBeUndefined()
  })
})

describe('normalizeFuel', () => {
  it('returns undefined for missing input', () => {
    expect(normalizeFuel(undefined)).toBeUndefined()
    expect(normalizeFuel('')).toBeUndefined()
  })

  it('classifies plug-in hybrids as phev before plain hybrid', () => {
    expect(normalizeFuel('Plug-in Hybrid')).toBe('phev')
    expect(normalizeFuel('PHEV')).toBe('phev')
  })

  it('classifies the remaining fuel types', () => {
    expect(normalizeFuel('Hybrid')).toBe('hybrid')
    expect(normalizeFuel('Diesel')).toBe('diesel')
    expect(normalizeFuel('Gasoline')).toBe('petrol')
    expect(normalizeFuel('Benzín')).toBe('petrol')
    expect(normalizeFuel('Fuel Cell')).toBe('hydrogen')
    expect(normalizeFuel('FCEV')).toBe('hydrogen')
    expect(normalizeFuel('Electric')).toBe('electric')
    expect(normalizeFuel('ev')).toBe('electric')
    expect(normalizeFuel('bev')).toBe('electric')
    expect(normalizeFuel('Autogas')).toBe('lpg')
    expect(normalizeFuel('Natural Gas')).toBe('cng')
    expect(normalizeFuel('Methane')).toBe('cng')
  })

  it('falls back to other for unrecognized fuels', () => {
    expect(normalizeFuel('Antimatter')).toBe('other')
  })
})

describe('normalizeTransmission', () => {
  it('returns undefined for missing input', () => {
    expect(normalizeTransmission(undefined)).toBeUndefined()
  })

  it('classifies each known transmission family', () => {
    expect(normalizeTransmission('DSG dual-clutch')).toBe('dct')
    expect(normalizeTransmission('PDK')).toBe('dct')
    expect(normalizeTransmission('CVT')).toBe('cvt')
    expect(normalizeTransmission('Continuously Variable')).toBe('cvt')
    expect(normalizeTransmission('Semi-automatic')).toBe('semi_automatic')
    expect(normalizeTransmission('Tiptronic')).toBe('semi_automatic')
    expect(normalizeTransmission('AMT')).toBe('semi_automatic')
    expect(normalizeTransmission('Manual')).toBe('manual')
    expect(normalizeTransmission('Automatic')).toBe('automatic')
  })

  it('leaves an unrecognized transmission undefined', () => {
    expect(normalizeTransmission('Warp drive')).toBeUndefined()
  })
})

describe('normalizeBody', () => {
  it('returns undefined for missing input', () => {
    expect(normalizeBody(undefined)).toBeUndefined()
  })

  it('classifies each body family', () => {
    expect(normalizeBody('Crossover SUV')).toBe('suv')
    expect(normalizeBody('Off-road')).toBe('suv')
    expect(normalizeBody('Pick-up')).toBe('pickup')
    expect(normalizeBody('Roadster')).toBe('convertible')
    expect(normalizeBody('Cabrio')).toBe('convertible')
    expect(normalizeBody('Coupé')).toBe('coupe')
    expect(normalizeBody('Liftback')).toBe('hatchback')
    expect(normalizeBody('Estate Kombi')).toBe('wagon')
    expect(normalizeBody('Avant')).toBe('wagon')
    expect(normalizeBody('Minivan')).toBe('minibus')
    expect(normalizeBody('Bus')).toBe('minibus')
    expect(normalizeBody('Panel van')).toBe('van')
    expect(normalizeBody('Saloon')).toBe('sedan')
    expect(normalizeBody('Limousine')).toBe('sedan')
  })

  it('falls back to other for unrecognized bodies', () => {
    expect(normalizeBody('Hovercraft')).toBe('other')
  })
})

describe('normalizeDrive', () => {
  it('returns undefined for missing input', () => {
    expect(normalizeDrive(undefined)).toBeUndefined()
  })

  it('classifies each drivetrain family', () => {
    expect(normalizeDrive('4x4')).toBe('4x4')
    expect(normalizeDrive('Four-wheel drive')).toBe('4x4')
    expect(normalizeDrive('Quattro')).toBe('awd')
    expect(normalizeDrive('xDrive')).toBe('awd')
    expect(normalizeDrive('4MATIC')).toBe('awd')
    expect(normalizeDrive('Front wheel drive')).toBe('fwd')
    expect(normalizeDrive('FWD')).toBe('fwd')
    expect(normalizeDrive('Rear wheel drive')).toBe('rwd')
    expect(normalizeDrive('RWD')).toBe('rwd')
  })

  it('leaves an unrecognized drivetrain undefined', () => {
    expect(normalizeDrive('Tank tracks')).toBeUndefined()
  })
})

describe('countNormalizedFields', () => {
  it('ignores undefined and empty-string fields', () => {
    expect(countNormalizedFields({ manufacturer: '', model: undefined } as never)).toBe(0)
    expect(countNormalizedFields({ manufacturer: 'Audi', enginePowerKw: 0 })).toBe(2)
  })
})
