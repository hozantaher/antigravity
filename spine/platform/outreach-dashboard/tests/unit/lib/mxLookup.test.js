import { describe, it, expect } from 'vitest'
import {
  classifyMxProvider,
  inferInfraClass,
  parseSpf,
  parseDmarc,
  probeDns,
} from '../../../src/lib/mxLookup.js'

describe('classifyMxProvider', () => {
  it.each([
    ['aspmx.l.google.com',                    'google_workspace'],
    ['firma.mail.protection.outlook.com',     'microsoft_365'],
    ['mxa.mailgun.org',                       'mailgun'],
    ['mx.sendgrid.net',                       'sendgrid'],
    ['inbound-smtp.eu-west-1.amazonses.com',  'aws_ses'],
    ['mx1.seznam.cz',                         'seznam_cz'],
    ['mx.firma.cz',                           'self_hosted'],
    ['mx1.forpsi.com',                        'forpsi'],
  ])('%s → %s', (mx, expected) => {
    expect(classifyMxProvider(mx)).toBe(expected)
  })

  it('null/empty → unknown', () => {
    expect(classifyMxProvider(null)).toBe('unknown')
    expect(classifyMxProvider('')).toBe('unknown')
    expect(classifyMxProvider(undefined)).toBe('unknown')
  })
})

describe('inferInfraClass', () => {
  it('maps providers to infra tiers', () => {
    expect(inferInfraClass('google_workspace')).toBe('enterprise_cloud')
    expect(inferInfraClass('mailgun')).toBe('tech_forward')
    expect(inferInfraClass('seznam_cz')).toBe('consumer_grade')
    expect(inferInfraClass('forpsi')).toBe('czech_hosting')
    expect(inferInfraClass('self_hosted')).toBe('self_hosted')
    expect(inferInfraClass('mystery_co')).toBe('unknown')
  })
})

describe('parseSpf', () => {
  it('detects strict -all policy', () => {
    const r = parseSpf([['v=spf1 include:_spf.google.com -all']])
    expect(r.has_spf).toBe(true)
    expect(r.spf_strict).toBe(true)
  })
  it('detects soft ~all as non-strict', () => {
    const r = parseSpf([['v=spf1 a mx ~all']])
    expect(r.has_spf).toBe(true)
    expect(r.spf_strict).toBe(false)
  })
  it('flat strings work too', () => {
    const r = parseSpf(['v=spf1 -all'])
    expect(r.has_spf).toBe(true)
    expect(r.spf_strict).toBe(true)
  })
  it('no SPF record → has_spf false', () => {
    expect(parseSpf([['random=value']])).toEqual({ has_spf: false, spf_strict: false })
    expect(parseSpf([])).toEqual({ has_spf: false, spf_strict: false })
    expect(parseSpf(null)).toEqual({ has_spf: false, spf_strict: false })
  })
})

describe('parseDmarc', () => {
  it.each([
    ['v=DMARC1; p=reject; rua=mailto:dmarc@firma.cz', 'reject'],
    ['v=DMARC1; p=quarantine; pct=100',               'quarantine'],
    ['v=DMARC1; p=none',                              'none'],
  ])('%s → %s', (rec, expected) => {
    const r = parseDmarc([[rec]])
    expect(r.has_dmarc).toBe(true)
    expect(r.dmarc_policy).toBe(expected)
  })
  it('no DMARC record → null policy', () => {
    expect(parseDmarc([['v=spf1 -all']])).toEqual({ has_dmarc: false, dmarc_policy: null })
  })
})

describe('probeDns — orchestration', () => {
  const mockResolveMx = (records) => () => Promise.resolve(records)
  const mockResolveTxt = (recsByName) => (name) => {
    if (recsByName[name]) return Promise.resolve(recsByName[name])
    const e = new Error(`no record for ${name}`); e.code = 'ENODATA'; return Promise.reject(e)
  }

  it('emits all 5 facts on healthy domain', async () => {
    const facts = await probeDns('firma.cz', {
      resolveMx:  mockResolveMx([{ priority: 10, exchange: 'aspmx.l.google.com' }]),
      resolveTxt: mockResolveTxt({
        'firma.cz':       [['v=spf1 -all']],
        '_dmarc.firma.cz':[['v=DMARC1; p=reject']],
      }),
    })
    const byField = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(byField.mx_provider).toBe('google_workspace')
    expect(byField.infra_class).toBe('enterprise_cloud')
    expect(byField.spf.spf_strict).toBe(true)
    expect(byField.dmarc.dmarc_policy).toBe('reject')
  })

  it('graceful when no MX/SPF/DMARC', async () => {
    const noData = (name) => { const e = new Error('nodata'); e.code = 'ENODATA'; return Promise.reject(e) }
    const facts = await probeDns('dead.cz', {
      resolveMx: () => { const e = new Error('nope'); e.code = 'ENOTFOUND'; return Promise.reject(e) },
      resolveTxt: noData,
    })
    const byField = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(byField.mx_provider).toBe('none')
    expect(byField.spf.has_spf).toBe(false)
    expect(byField.dmarc.has_dmarc).toBe(false)
  })

  it('rejects invalid domain', async () => {
    await expect(probeDns('not-a-domain')).rejects.toThrow(/invalid domain/)
    await expect(probeDns('')).rejects.toThrow(/invalid domain/)
  })

  it('orders MX by priority (lowest first)', async () => {
    const facts = await probeDns('firma.cz', {
      resolveMx:  mockResolveMx([
        { priority: 20, exchange: 'mx2.seznam.cz' },
        { priority: 10, exchange: 'aspmx.l.google.com' },
      ]),
      resolveTxt: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENODATA' })),
    })
    const mxRecords = facts.find(f => f.field === 'mx_records').value
    expect(mxRecords[0]).toBe('aspmx.l.google.com')
  })

  it('reflects parser version', () => {
    expect(probeDns.version).toBe('mx_v1')
  })
})
