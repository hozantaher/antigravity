import { describe, test, expect, vi } from 'vitest'
import { computeCampaignPreflight, PREFLIGHT_CONSTANTS } from '../../../campaignPreflight.js'

// Mock pool implementation — returns rows based on SQL fragment matching.
function makePool(responses) {
  return {
    query: vi.fn(async (sql, params) => {
      for (const [fragment, result] of responses) {
        if (sql.includes(fragment)) {
          return typeof result === 'function' ? await result(params) : result
        }
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`)
    }),
  }
}

const activeCamp = {
  id: 1, name: 'Strojírenství', status: 'paused',
  sequence_config: { steps: [{ step: 0, template: 'initial' }, { step: 1, template: 'followup1' }] },
}

function goodResponses(overrides = {}) {
  const base = new Map([
    ['FROM campaigns WHERE', { rows: [activeCamp] }],
    ['SELECT id, from_address, proxy_url', {
      rows: [
        { id: 10, from_address: 'a@b', proxy_url: 'socks5://1:1080', daily_cap_override: 50 },
        { id: 11, from_address: 'c@d', proxy_url: 'socks5://2:1080', daily_cap_override: 60 },
      ],
    }],
    ['JOIN LATERAL', { rows: [{ id: 10 }, { id: 11 }] }],
    ['suppression_list', { rows: [{ n: 42 }] }],
    ['FROM email_templates', {
      rows: [
        { name: 'initial', subject: 'Hi', body: 'Hello' },
        { name: 'followup1', subject: 'Hey', body: 'Again' },
      ],
    }],
    ['FROM campaign_contacts', { rows: [{ n: 250 }] }],
  ])
  for (const [k, v] of Object.entries(overrides)) base.set(k, v)
  return [...base.entries()]
}

describe('computeCampaignPreflight', () => {
  test('returns null for unknown campaign', async () => {
    const pool = makePool([['FROM campaigns WHERE', { rows: [] }]])
    expect(await computeCampaignPreflight(pool, 999)).toBeNull()
  })

  test('all-green happy path', async () => {
    const pool = makePool(goodResponses())
    const out = await computeCampaignPreflight(pool, 1)
    expect(out.ok).toBe(true)
    expect(out.campaign_id).toBe(1)
    expect(out.campaign_name).toBe('Strojírenství')
    expect(out.checks).toHaveLength(6)
    expect(out.checks.every(c => c.ok)).toBe(true)
    expect(out.enrolled_count).toBe(250)
  })

  // MVP-2: silent-zero-send guard
  test('fails when campaign_contacts is empty (silent zero-send guard)', async () => {
    const pool = makePool(goodResponses({
      'FROM campaign_contacts': { rows: [{ n: 0 }] },
    }))
    const out = await computeCampaignPreflight(pool, 1)
    expect(out.ok).toBe(false)
    const chk = out.checks.find(c => c.name === 'enrollment_populated')
    expect(chk.ok).toBe(false)
    expect(chk.reason).toMatch(/campaign_contacts prázdné/)
    expect(chk.enrolled_count).toBe(0)
    expect(out.enrolled_count).toBe(0)
  })

  test('passes when campaign_contacts has any rows', async () => {
    const pool = makePool(goodResponses({
      'FROM campaign_contacts': { rows: [{ n: 1 }] },
    }))
    const out = await computeCampaignPreflight(pool, 1)
    const chk = out.checks.find(c => c.name === 'enrollment_populated')
    expect(chk.ok).toBe(true)
    expect(out.enrolled_count).toBe(1)
  })

  test('treats query failure as zero (defensive — table may not exist in dev)', async () => {
    const pool = makePool(goodResponses({
      'FROM campaign_contacts': () => { throw new Error('relation does not exist') },
    }))
    const out = await computeCampaignPreflight(pool, 1)
    const chk = out.checks.find(c => c.name === 'enrollment_populated')
    expect(chk.ok).toBe(false)
    expect(out.enrolled_count).toBe(0)
  })

  test('fails when mailbox missing proxy_url', async () => {
    const pool = makePool(goodResponses({
      'SELECT id, from_address, proxy_url': {
        rows: [
          { id: 10, from_address: 'a@b', proxy_url: null, daily_cap_override: 100 },
          { id: 11, from_address: 'c@d', proxy_url: 'socks5://1:1080', daily_cap_override: 100 },
        ],
      },
    }))
    const out = await computeCampaignPreflight(pool, 1)
    expect(out.ok).toBe(false)
    const chk = out.checks.find(c => c.name === 'proxy_assignments')
    expect(chk.ok).toBe(false)
    expect(chk.reason).toMatch(/1 mailboxů bez proxy_url/)
  })

  test('fails when no active mailboxes', async () => {
    const pool = makePool(goodResponses({
      'SELECT id, from_address, proxy_url': { rows: [] },
      'JOIN LATERAL': { rows: [] },
    }))
    const out = await computeCampaignPreflight(pool, 1)
    expect(out.ok).toBe(false)
    expect(out.checks.find(c => c.name === 'proxy_assignments').ok).toBe(false)
  })

  test('fails on stale full-check', async () => {
    const pool = makePool(goodResponses({
      'JOIN LATERAL': { rows: [{ id: 10 }] }, // only 1 of 2 mailboxes fresh
    }))
    const out = await computeCampaignPreflight(pool, 1)
    const chk = out.checks.find(c => c.name === 'full_check_fresh')
    expect(chk.ok).toBe(false)
    expect(chk.reason).toMatch(/1 mailboxů bez fresh full-check/)
  })

  test('fails when suppression list empty', async () => {
    const pool = makePool(goodResponses({
      'suppression_list': { rows: [{ n: 0 }] },
    }))
    const out = await computeCampaignPreflight(pool, 1)
    const chk = out.checks.find(c => c.name === 'suppression_populated')
    expect(chk.ok).toBe(false)
  })

  test('fails when daily capacity below minimum', async () => {
    const pool = makePool(goodResponses({
      'SELECT id, from_address, proxy_url': {
        rows: [{ id: 10, proxy_url: 'socks5://1:1080', daily_cap_override: 30 }],
      },
      'JOIN LATERAL': { rows: [{ id: 10 }] },
    }))
    const out = await computeCampaignPreflight(pool, 1)
    const chk = out.checks.find(c => c.name === 'daily_capacity')
    expect(chk.ok).toBe(false)
    expect(chk.reason).toMatch(new RegExp(`${PREFLIGHT_CONSTANTS.MIN_DAILY_CAPACITY}`))
  })

  test('fails when sequence_config references missing templates', async () => {
    const pool = makePool(goodResponses({
      'FROM email_templates': {
        rows: [{ name: 'initial', subject: 'Hi', body: 'Hello' }],
        // 'followup1' not returned → missing
      },
    }))
    const out = await computeCampaignPreflight(pool, 1)
    const chk = out.checks.find(c => c.name === 'templates_valid')
    expect(chk.ok).toBe(false)
    expect(chk.reason).toMatch(/chybí šablony.*followup1/)
  })

  test('fails when template has empty body', async () => {
    const pool = makePool(goodResponses({
      'FROM email_templates': {
        rows: [
          { name: 'initial', subject: 'Hi', body: '' },
          { name: 'followup1', subject: 'Hey', body: 'Again' },
        ],
      },
    }))
    const out = await computeCampaignPreflight(pool, 1)
    const chk = out.checks.find(c => c.name === 'templates_valid')
    expect(chk.ok).toBe(false)
    expect(chk.reason).toMatch(/prázdné šablony.*initial/)
  })

  test('fails when sequence_config has no templates', async () => {
    const camp = { ...activeCamp, sequence_config: { steps: [] } }
    const pool = makePool(goodResponses({
      'FROM campaigns WHERE': { rows: [camp] },
    }))
    const out = await computeCampaignPreflight(pool, 1)
    const chk = out.checks.find(c => c.name === 'templates_valid')
    expect(chk.ok).toBe(false)
    expect(chk.reason).toMatch(/bez šablon/)
  })

  // Discipline test: preflight must mirror the runner's send-time UNION
  // filter (features/outreach/campaigns/campaign/runner.go suppressionFilterSQL).
  // If a refactor drops one side, the gate becomes inconsistent with the
  // actual runtime suppression filter and the operator will see a green
  // gate while the runner is filtering against a different table.
  test('suppression check unions both suppression tables', async () => {
    let capturedSQL = ''
    const pool = {
      query: vi.fn(async (sql, params) => {
        if (sql.includes('outreach_suppressions') && sql.includes('suppression_list')) {
          capturedSQL = sql
          return { rows: [{ n: 5 }] }
        }
        if (sql.includes('FROM campaigns WHERE')) return { rows: [activeCamp] }
        if (sql.includes('SELECT id, from_address, proxy_url')) {
          return { rows: [{ id: 10, proxy_url: 'socks5://1:1080', daily_cap_override: 100 }] }
        }
        if (sql.includes('JOIN LATERAL')) return { rows: [{ id: 10 }] }
        if (sql.includes('FROM email_templates')) {
          return { rows: [
            { name: 'initial', subject: 'Hi', body: 'Hello' },
            { name: 'followup1', subject: 'Hey', body: 'Again' },
          ] }
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`)
      }),
    }
    await computeCampaignPreflight(pool, 1)
    expect(capturedSQL).toMatch(/outreach_suppressions/)
    expect(capturedSQL).toMatch(/suppression_list/)
    expect(capturedSQL).toMatch(/UNION/)
  })

  test('accepts legacy array sequence_config shape', async () => {
    const camp = { ...activeCamp, sequence_config: [{ step: 0, template: 'initial' }, { step: 1, template: 'followup1' }] }
    const pool = makePool(goodResponses({ 'FROM campaigns WHERE': { rows: [camp] } }))
    const out = await computeCampaignPreflight(pool, 1)
    expect(out.ok).toBe(true)
  })
})
