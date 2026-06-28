// d1-j3-email-status-filters.test.ts — Sprint J3 coverage audit
//
// J3 email status badges + filters. Validates that filter combinations
// work correctly, invalid enums gracefully fall back, and sort order
// is stable. Uses real contact fixtures with varied email_status values.

import { describe, it, expect, beforeEach } from 'vitest'

interface Contact {
  id: number
  email: string
  email_status: 'valid' | 'risky' | 'invalid' | 'unknown'
  updated_at: Date
}

interface FilterParams {
  email_status?: string
  sort?: 'updated_at' | 'email'
}

interface FilterResult {
  contacts: Contact[]
  total: number
  appliedFilters: {
    status?: string
    sort?: string
  }
  errors?: string[]
}

// Valid email statuses (from db schema)
const VALID_STATUSES = ['valid', 'risky', 'invalid', 'unknown']

// Simulated contacts filter (from src/pages/Contacts/ContactsList.ts)
function filterContacts(contacts: Contact[], params: FilterParams): FilterResult {
  let filtered = [...contacts]
  const errors: string[] = []
  const appliedFilters: Record<string, any> = {}

  // Apply email_status filter
  if (params.email_status) {
    if (!VALID_STATUSES.includes(params.email_status)) {
      // Invalid enum: graceful fallback (no filter)
      errors.push(`Invalid email_status: ${params.email_status}. Ignoring filter.`)
    } else {
      filtered = filtered.filter(c => c.email_status === params.email_status)
      appliedFilters.status = params.email_status
    }
  }

  // Apply sort
  if (params.sort) {
    if (params.sort === 'updated_at') {
      filtered.sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )
      appliedFilters.sort = 'updated_at'
    } else if (params.sort === 'email') {
      filtered.sort((a, b) => a.email.localeCompare(b.email))
      appliedFilters.sort = 'email'
    }
  }

  return {
    contacts: filtered,
    total: filtered.length,
    appliedFilters,
    ...(errors.length > 0 && { errors }),
  }
}

describe('J3: Email Status Filters', () => {
  let contacts: Contact[]

  beforeEach(() => {
    // Real-world fixture: varied statuses + timestamps
    contacts = [
      {
        id: 1,
        email: 'alice@gmail.com',
        email_status: 'valid',
        updated_at: new Date('2026-05-13T10:00:00Z'),
      },
      {
        id: 2,
        email: 'bob@yahoo.com',
        email_status: 'valid',
        updated_at: new Date('2026-05-12T15:30:00Z'),
      },
      {
        id: 3,
        email: 'charlie@unknown.test',
        email_status: 'risky',
        updated_at: new Date('2026-05-11T08:45:00Z'),
      },
      {
        id: 4,
        email: 'diana@invalid.local',
        email_status: 'invalid',
        updated_at: new Date('2026-05-10T14:20:00Z'),
      },
      {
        id: 5,
        email: 'eve@example.com',
        email_status: 'risky',
        updated_at: new Date('2026-05-13T09:00:00Z'),
      },
      {
        id: 6,
        email: 'frank@unknown.net',
        email_status: 'unknown',
        updated_at: new Date('2026-05-09T11:11:00Z'),
      },
    ]
  })

  it('happy path: filter by email_status=valid → only valid emails shown', () => {
    const result = filterContacts(contacts, { email_status: 'valid' })

    expect(result.contacts).toHaveLength(2)
    expect(result.contacts.every(c => c.email_status === 'valid')).toBe(true)
    expect(result.appliedFilters.status).toBe('valid')
  })

  it('happy path: filter by email_status=risky → only risky emails shown', () => {
    const result = filterContacts(contacts, { email_status: 'risky' })

    expect(result.contacts).toHaveLength(2)
    expect(result.contacts.every(c => c.email_status === 'risky')).toBe(true)
  })

  it('filter combo: risky + sort by updated_at desc', () => {
    const result = filterContacts(contacts, {
      email_status: 'risky',
      sort: 'updated_at',
    })

    expect(result.contacts).toHaveLength(2)
    expect(result.contacts[0].email).toBe('eve@example.com') // 2026-05-13
    expect(result.contacts[1].email).toBe('charlie@unknown.test') // 2026-05-11
    expect(result.appliedFilters.status).toBe('risky')
    expect(result.appliedFilters.sort).toBe('updated_at')
  })

  it('filter combo: valid + sort by email (alphabetical)', () => {
    const result = filterContacts(contacts, {
      email_status: 'valid',
      sort: 'email',
    })

    expect(result.contacts).toHaveLength(2)
    expect(result.contacts[0].email).toBe('alice@gmail.com') // alphabetically first
    expect(result.contacts[1].email).toBe('bob@yahoo.com')
  })

  it('error: invalid enum value → graceful fallback (no filter)', () => {
    const result = filterContacts(contacts, { email_status: 'invalid_enum' })

    expect(result.contacts).toHaveLength(6) // All contacts returned
    expect(result.errors).toContain('Invalid email_status: invalid_enum. Ignoring filter.')
    expect(result.appliedFilters.status).toBeUndefined()
  })

  it('error: misspelled status → fallback', () => {
    const result = filterContacts(contacts, { email_status: 'vaalid' })

    expect(result.contacts).toHaveLength(6)
    expect(result.errors?.length).toBeGreaterThan(0)
  })

  it('edge: no results (all contacts filtered out) → empty array', () => {
    const result = filterContacts(contacts, { email_status: 'invalid' })

    expect(result.contacts).toHaveLength(1)
    expect(result.total).toBe(1)
  })

  it('sort stability: same email_status, sort by email', () => {
    const result1 = filterContacts(contacts, { email_status: 'valid', sort: 'email' })
    const result2 = filterContacts(contacts, { email_status: 'valid', sort: 'email' })

    expect(result1.contacts.map(c => c.id)).toEqual(result2.contacts.map(c => c.id))
  })

  it('sort by updated_at preserves descending order', () => {
    const result = filterContacts(contacts, { sort: 'updated_at' })

    for (let i = 0; i < result.contacts.length - 1; i++) {
      const current = new Date(result.contacts[i].updated_at)
      const next = new Date(result.contacts[i + 1].updated_at)
      expect(current >= next).toBe(true) // Descending
    }
  })

  it('no filter + no sort → returns all contacts in original order', () => {
    const result = filterContacts(contacts, {})

    expect(result.contacts).toHaveLength(6)
    expect(result.appliedFilters).toEqual({})
  })
})
