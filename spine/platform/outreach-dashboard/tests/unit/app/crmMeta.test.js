/** crmMeta — CRM klienti helpers. */
import { describe, it, expect } from 'vitest'
import { clientName, crmStatusMeta, relationshipLabel } from '../../../src/app/lib/crmMeta'

describe('clientName', () => {
  it('prefers name, then email, then ico, then placeholder', () => {
    expect(clientName({ name: ' ACME ' })).toBe('ACME')
    expect(clientName({ email_primary: 'a@b.cz' })).toBe('a@b.cz')
    expect(clientName({ ico: '123' })).toBe('123')
    expect(clientName({})).toBe('Bez názvu')
  })
})
describe('crmStatusMeta', () => {
  it('maps prod statuses, null for blank', () => {
    expect(crmStatusMeta('Aktuální').label).toBe('Aktuální')
    expect(crmStatusMeta('Potenciální').fg).toBe('var(--app-accent-strong)')
    expect(crmStatusMeta('lead').label).toBe('Lead')
    expect(crmStatusMeta('')).toBeNull()
    expect(crmStatusMeta(null)).toBeNull()
    expect(crmStatusMeta('Jiné').label).toBe('Jiné')
  })
})
describe('relationshipLabel', () => {
  it('humanizes vehicle_offered, null for blank', () => {
    expect(relationshipLabel('vehicle_offered')).toBe('Nabídnuto vozidlo')
    expect(relationshipLabel('')).toBeNull()
    expect(relationshipLabel(null)).toBeNull()
  })
})
