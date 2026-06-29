import { describe, expect, it } from 'vitest'
import { COMPANY } from '~/utils/company'

describe('COMPANY', () => {
  it('exposes the fixed legal facts', () => {
    expect(COMPANY).toEqual({
      name: 'East West 24 s.r.o.',
      ico: '21474737',
      dic: 'CZ21474737',
      email: 'info@auction24.cz',
      street: 'Sanderova 1616/16',
      city: 'Praha 7, 170 00',
      country: 'Czech Republic',
      addressLine: 'Sanderova 1616/16, Praha 7, 170 00, Czech Republic',
      copyright: '© 2026 East West 24 s.r.o. - All rights reserved. CIN: 21474737',
    })
  })

  it('composes addressLine from the address parts', () => {
    expect(COMPANY.addressLine).toBe(`${COMPANY.street}, ${COMPANY.city}, ${COMPANY.country}`)
  })

  it('embeds the legal name and CIN in the copyright line', () => {
    expect(COMPANY.copyright).toContain(COMPANY.name)
    expect(COMPANY.copyright).toContain(COMPANY.ico)
  })
})
