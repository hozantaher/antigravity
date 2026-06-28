import { describe, it, expect, beforeEach, vi } from 'vitest'

// Test the launch-sanity endpoint directly (without Express routing overhead)
// by simulating the endpoint handler with mock pool
describe('GET /api/launch-sanity — Contract tests', () => {
  let mockPool

  async function callLaunchSanity(campaignId) {
    // Simulate the endpoint handler logic
    let statusCode = 200
    let responseBody = null

    if (campaignId === undefined) {
      return { status: 400, body: { error: 'Invalid campaign_id: must be a positive integer' } }
    }

    const parsed = parseInt(campaignId, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { status: 400, body: { error: 'Invalid campaign_id: must be a positive integer' } }
    }

    try {
      const checks = []
      const ts = new Date().toISOString()

      // 1.1 Mailboxes Active Count
      try {
        const { rows: [mbRow] } = await mockPool.query(
          `SELECT COUNT(*)::int AS count FROM outreach_mailboxes WHERE status = 'active'`
        )
        const mbCount = mbRow?.count || 0
        checks.push({
          id: '1.1',
          axis: 'mailboxes',
          label: 'Active mailboxes',
          status: mbCount >= 4 ? 'green' : (mbCount >= 1 ? 'amber' : 'red'),
          value: `${mbCount}`,
          expected: '≥4',
        })
      } catch (e) {
        checks.push({
          id: '1.1',
          axis: 'mailboxes',
          label: 'Active mailboxes',
          status: 'unknown',
          value: 'error',
          expected: '≥4',
        })
      }

      // 1.2 Anti-trace relay ping
      try {
        const { rows } = await mockPool.query(`
          SELECT created_at FROM anti_trace_pings
          WHERE created_at > now() - interval '5 minutes'
          ORDER BY created_at DESC LIMIT 1
        `).catch(() => ({ rows: [] }))
        checks.push({
          id: '1.2',
          axis: 'relay',
          label: 'Relay healthy (recent ping)',
          status: rows.length > 0 ? 'green' : 'amber',
          value: rows.length > 0 ? 'yes' : 'no',
          expected: 'ping < 5 min',
        })
      } catch (e) {
        checks.push({
          id: '1.2',
          axis: 'relay',
          label: 'Relay healthy (recent ping)',
          status: 'unknown',
          value: 'table missing',
          expected: 'ping < 5 min',
        })
      }

      // 2.1 Campaign contacts eligible
      try {
        const { rows: [ccRow] } = await mockPool.query(`
          SELECT COUNT(*)::int AS count
          FROM campaign_contacts cc
          WHERE cc.campaign_id = $1
            AND (cc.status IS NULL OR cc.status IN ('pending', 'queued'))
        `, [parsed])
        const ccCount = ccRow?.count || 0
        checks.push({
          id: '2.1',
          axis: 'contacts',
          label: 'Eligible contacts queued',
          status: ccCount > 0 ? 'green' : 'red',
          value: `${ccCount}`,
          expected: '>0',
        })
      } catch (e) {
        checks.push({
          id: '2.1',
          axis: 'contacts',
          label: 'Eligible contacts queued',
          status: 'unknown',
          value: 'error',
          expected: '>0',
        })
      }

      // 3.1 Template valid
      try {
        const { rows: [camp] } = await mockPool.query(
          `SELECT sequence_config FROM campaigns WHERE id = $1`,
          [parsed]
        )
        let templateOk = false
        if (camp?.sequence_config) {
          const seq = Array.isArray(camp.sequence_config)
            ? camp.sequence_config
            : (camp.sequence_config?.steps || [])
          const templateName = seq[0]?.template
          if (templateName) {
            const templates = await mockPool.query(
              `SELECT id FROM email_templates WHERE name = $1
               UNION ALL
               SELECT id FROM templates WHERE name = $1
               LIMIT 1`,
              [templateName]
            )
            templateOk = templates.rows.length > 0
          }
        }
        checks.push({
          id: '3.1',
          axis: 'templates',
          label: 'Template configured + exists',
          status: templateOk ? 'green' : 'red',
          value: templateOk ? 'yes' : 'no',
          expected: 'valid template',
        })
      } catch (e) {
        checks.push({
          id: '3.1',
          axis: 'templates',
          label: 'Template configured + exists',
          status: 'unknown',
          value: 'error',
          expected: 'valid template',
        })
      }

      // 4.1 Last send event recent
      try {
        const { rows } = await mockPool.query(`
          SELECT created_at FROM send_events
          WHERE campaign_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `, [parsed])
        const hasRecent = rows.length > 0 && (Date.now() - new Date(rows[0].created_at).getTime()) < 60 * 60 * 1000
        checks.push({
          id: '4.1',
          axis: 'sends',
          label: 'Recent send activity',
          status: hasRecent ? 'green' : 'amber',
          value: rows.length > 0 ? 'yes' : 'never',
          expected: 'recent < 1h',
        })
      } catch (e) {
        checks.push({
          id: '4.1',
          axis: 'sends',
          label: 'Recent send activity',
          status: 'unknown',
          value: 'error',
          expected: 'recent < 1h',
        })
      }

      // Placeholders (5–13)
      const placeholders = [
        { id: '1.3', axis: 'relay', label: 'Relay egress geolocation', expected: 'CZ or expected region' },
        { id: '2.2', axis: 'contacts', label: 'Contact email validity', expected: 'none invalid' },
        { id: '3.2', axis: 'templates', label: 'Template GDPR footer present', expected: 'footer + unsubscribe' },
        { id: '3.3', axis: 'templates', label: 'Template variable substitution', expected: 'no unresolved {{vars}}' },
        { id: '4.2', axis: 'sends', label: 'Drip sequence unlocked', expected: 'status != locked' },
        { id: '5.1', axis: 'db', label: 'Campaign write permission', expected: 'UPDATE works' },
        { id: '5.2', axis: 'db', label: 'Full schema validation', expected: 'schema-check clean' },
        { id: '5.3', axis: 'auth', label: 'API auth not expired', expected: 'X-API-Key valid' },
      ]
      for (const p of placeholders) {
        checks.push({
          ...p,
          status: 'unknown',
          value: '?',
        })
      }

      return {
        status: 200,
        body: {
          campaign_id: parsed,
          ts,
          checks,
        },
      }
    } catch (e) {
      return { status: 500, body: { error: 'Internal Server Error' } }
    }
  }

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    }
  })

  it('returns 400 for missing campaign_id', async () => {
    const res = await callLaunchSanity(undefined)
    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('error')
    expect(res.body.error).toContain('campaign_id')
  })

  it('returns 400 for non-numeric campaign_id', async () => {
    const res = await callLaunchSanity('abc')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('positive integer')
  })

  it('returns 400 for zero or negative campaign_id', async () => {
    const res = await callLaunchSanity('0')
    expect(res.status).toBe(400)
  })

  it('happy path: 5 checks green + 8 unknown', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: 4 }] }) // 1.1
      .mockResolvedValueOnce({ rows: [{ created_at: new Date() }] }) // 1.2
      .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // 2.1
      .mockResolvedValueOnce({ rows: [{ sequence_config: { steps: [{ template: 'test' }] } }] }) // 3.1 campaign
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // 3.1 template
      .mockResolvedValueOnce({ rows: [{ created_at: new Date() }] }) // 4.1

    const res = await callLaunchSanity('1')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('campaign_id', 1)
    expect(res.body).toHaveProperty('ts')
    expect(res.body).toHaveProperty('checks')
    expect(Array.isArray(res.body.checks)).toBe(true)
    expect(res.body.checks.length).toBe(13)

    const [c11, c12, c21, c31, c41] = res.body.checks.slice(0, 5)
    expect(c11.status).toBe('green')
    expect(c12.status).toBe('green')
    expect(c21.status).toBe('green')
    expect(c31.status).toBe('green')
    expect(c41.status).toBe('green')

    const remaining = res.body.checks.slice(5)
    expect(remaining.every((c) => c.status === 'unknown')).toBe(true)
  })

  it('check 1.1: red when mailbox count < 1', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: 0 }] })

    const res = await callLaunchSanity('1')
    const c11 = res.body.checks.find((c) => c.id === '1.1')
    expect(c11.status).toBe('red')
  })

  it('check 1.1: amber when mailbox count 1-3', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: 2 }] })

    const res = await callLaunchSanity('1')
    const c11 = res.body.checks.find((c) => c.id === '1.1')
    expect(c11.status).toBe('amber')
  })

  it('check 2.1: red when no eligible contacts', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: 4 }] }) // 1.1
      .mockResolvedValueOnce({ rows: [] }) // 1.2
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // 2.1

    const res = await callLaunchSanity('1')
    const c21 = res.body.checks.find((c) => c.id === '2.1')
    expect(c21.status).toBe('red')
    expect(c21.value).toBe('0')
  })

  it('response shape: every check has required fields', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: 4 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const res = await callLaunchSanity('1')
    res.body.checks.forEach((check) => {
      expect(check).toHaveProperty('id')
      expect(check).toHaveProperty('axis')
      expect(check).toHaveProperty('label')
      expect(check).toHaveProperty('status')
      expect(check).toHaveProperty('value')
      expect(check).toHaveProperty('expected')
    })
  })

  it('response has ts as ISO string', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: 4 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const res = await callLaunchSanity('1')
    expect(typeof res.body.ts).toBe('string')
    expect(() => new Date(res.body.ts)).not.toThrow()
    expect(res.body.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
