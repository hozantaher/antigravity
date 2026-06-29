import { describe, it, expect } from 'vitest'
import { ItemType, type Item } from '~/models'
import { buildVehicleLd } from '~/features/supply/vehicle-vin/logic/vehicleStructuredData'

const item = (over: Partial<Item> = {}): Item =>
  ({
    id: 'x',
    title: 't',
    image: '',
    images: [],
    images360: [],
    description: {},
    highlights: {},
    categoryId: 'c',
    userId: 'u',
    bids: [],
    priceHighlighted: false,
    taxIncluded: false,
    sold: false,
    closed: false,
    hidden: false,
    type: ItemType.auction,
    ...over,
  }) as Item

describe('buildVehicleLd', () => {
  it('returns null without any vehicle signal', () => {
    expect(buildVehicleLd(item())).toBeNull()
  })

  it('uses the Car type for passenger-car bodies', () => {
    const ld = buildVehicleLd(item({ bodyType: 'suv', specs: { manufacturer: 'BMW', model: 'X5' } }))
    expect(ld?.vehicleType).toBe('Car')
    expect(ld?.properties.manufacturer).toBe('BMW')
    expect(ld?.properties.model).toBe('X5')
  })

  it('falls back to the generic Vehicle type for non-car bodies and bare signals', () => {
    expect(buildVehicleLd(item({ bodyType: 'van', fuelType: 'diesel' }))?.vehicleType).toBe('Vehicle')
    expect(buildVehicleLd(item({ vin: 'WDB123' }))?.vehicleType).toBe('Vehicle')
  })

  it('normalizes fuel, transmission and drive to schema-friendly values', () => {
    const p = buildVehicleLd(item({ fuelType: 'petrol', transmission: 'dct', driveType: 'awd' }))!.properties
    expect(p.fuelType).toBe('Gasoline')
    expect(p.vehicleTransmission).toBe('Dual-clutch')
    expect(p.driveWheelConfiguration).toBe('AllWheelDriveConfiguration')
  })

  it('emits engine power/displacement as QuantitativeValue with unit codes', () => {
    const p = buildVehicleLd(item({ enginePowerKw: 110, engineDisplacementCcm: 1968 }))!.properties
    expect(p.vehicleEngine).toEqual({
      '@type': 'EngineSpecification',
      enginePower: { '@type': 'QuantitativeValue', value: 110, unitCode: 'KWT' },
      engineDisplacement: { '@type': 'QuantitativeValue', value: 1968, unitCode: 'CMQ' },
    })
  })

  it('carries VIN, doors and seats', () => {
    const p = buildVehicleLd(item({ vin: 'WVW123', specs: { numberOfDoors: 5, numberOfSeats: 5 } }))!.properties
    expect(p.vehicleIdentificationNumber).toBe('WVW123')
    expect(p.numberOfDoors).toBe(5)
    expect(p.vehicleSeatingCapacity).toBe(5)
  })

  it('emits model date, first registration date and color', () => {
    const p = buildVehicleLd(
      item({
        vin: 'WAU123',
        color: 'black',
        firstRegistrationDate: 1577836800000 as unknown as Item['firstRegistrationDate'],
        specs: { manufacturer: 'Audi', yearOfManufacture: 2020 },
      }),
    )!.properties
    expect(p.vehicleModelDate).toBe('2020')
    expect(p.dateVehicleFirstRegistered).toBe(1577836800000)
    expect(p.color).toBe('black')
  })

  it('passes through unknown enum values verbatim', () => {
    const p = buildVehicleLd(
      item({
        fuelType: 'methanol' as unknown as Item['fuelType'],
        transmission: 'tiptronic' as unknown as Item['transmission'],
        driveType: '6x6' as unknown as Item['driveType'],
      }),
    )!.properties
    expect(p.fuelType).toBe('methanol')
    expect(p.vehicleTransmission).toBe('tiptronic')
    expect(p.driveWheelConfiguration).toBe('6x6')
  })

  it('detects signal from engine power and emits a single-spec engine', () => {
    const ld = buildVehicleLd(item({ enginePowerKw: 90 }))
    expect(ld?.vehicleType).toBe('Vehicle')
    expect(ld?.properties.vehicleEngine).toEqual({
      '@type': 'EngineSpecification',
      enginePower: { '@type': 'QuantitativeValue', value: 90, unitCode: 'KWT' },
    })
  })

  it('detects signal from displacement alone', () => {
    const p = buildVehicleLd(item({ engineDisplacementCcm: 1600 }))!.properties
    expect(p.vehicleEngine).toEqual({
      '@type': 'EngineSpecification',
      engineDisplacement: { '@type': 'QuantitativeValue', value: 1600, unitCode: 'CMQ' },
    })
  })

  it('detects signal from model alone and carries bodyType for non-car bodies', () => {
    const ld = buildVehicleLd(item({ bodyType: 'pickup', specs: { model: 'Actros' } }))
    expect(ld?.vehicleType).toBe('Vehicle')
    expect(ld?.properties.bodyType).toBe('pickup')
    expect(ld?.properties.model).toBe('Actros')
  })
})
