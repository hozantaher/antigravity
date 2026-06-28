/**
 * contactMeta — Kontakty presentation helpers.
 * Spustit: cd features/platform/outreach-dashboard && pnpm test tests/unit/contactMeta
 */
import { describe, it, expect } from 'vitest'
import { contactName, emailStatusMeta, crmLabel, contactStatusLabel, campaignContactStatusLabel } from '../../../src/app/lib/contactMeta'

describe('contactName', () => {
  it('prefers full name, then email, then placeholder', () => {
    expect(contactName({ first_name: 'Jan', last_name: 'Novák' })).toBe('Jan Novák')
    expect(contactName({ first_name: 'Jan' })).toBe('Jan')
    expect(contactName({ email: 'j@x.cz' })).toBe('j@x.cz')
    expect(contactName({})).toBe('Bez jména')
  })
})

describe('emailStatusMeta', () => {
  it('maps known statuses, returns null for unknown/blank (no chip)', () => {
    expect(emailStatusMeta('valid').label).toBe('Ověřený')
    expect(emailStatusMeta('invalid').label).toBe('Neplatný')
    expect(emailStatusMeta('risky').label).toBe('Rizikový')
    expect(emailStatusMeta('unknown')).toBeNull()
    expect(emailStatusMeta(null)).toBeNull()
  })
})

describe('crmLabel', () => {
  it('returns null when not in CRM', () => {
    expect(crmLabel({})).toBeNull()
    expect(crmLabel({ crm_client_id: null })).toBeNull()
  })
  it('labels CRM with relationship when present', () => {
    expect(crmLabel({ crm_client_id: 5 })).toBe('CRM')
    expect(crmLabel({ crm_client_id: 5, crm: { crm_relationship: 'partner' } })).toBe('CRM · partner')
    expect(crmLabel({ crm_client_id: 5, crm: { crm_status: 'active' } })).toBe('CRM · active')
  })
})

describe('contactStatusLabel (#1586 R2)', () => {
  it('maps real contact statuses to Czech', () => {
    expect(contactStatusLabel('valid')).toBe('Aktivní')
    expect(contactStatusLabel('bounced')).toBe('Odražený')
    expect(contactStatusLabel('sent')).toBe('Osloven')
  })
  it('falls back to the raw value for unmapped, null for empty', () => {
    expect(contactStatusLabel('mystery')).toBe('mystery')
    expect(contactStatusLabel(null)).toBeNull()
  })
})

describe('campaignContactStatusLabel (#1586 R2)', () => {
  it('maps real campaign_contact statuses to Czech', () => {
    expect(campaignContactStatusLabel('pending')).toBe('Čeká')
    expect(campaignContactStatusLabel('skipped')).toBe('Přeskočeno')
    expect(campaignContactStatusLabel('in_flight')).toBe('Odesílá se')
  })
  it('falls back to raw / null', () => {
    expect(campaignContactStatusLabel('weird')).toBe('weird')
    expect(campaignContactStatusLabel(null)).toBeNull()
  })
})
