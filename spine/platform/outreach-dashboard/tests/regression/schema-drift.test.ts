// S9 — Schema drift regression test.
// Replays historical drift scenarios — proves they would be caught now.
// Uses src/lib/schema-diff.js (S2) as single source of truth.

import { describe, it, expect } from 'vitest'
// @ts-ignore
import { diffManifests, quickCheck } from '../../src/lib/schema-diff.js'

const baseManifest = {
  version: '1',
  manifest_hash: 'sha256:base',
  tables: {
    email_templates: {
      columns: [
        { name: 'id',         type: 'integer', nullable: false, default: null },
        { name: 'name',       type: 'text',    nullable: false, default: null },
        { name: 'subject',    type: 'text',    nullable: false, default: null },
        { name: 'body',       type: 'text',    nullable: false, default: null },
        { name: 'created_at', type: 'timestamp with time zone', nullable: true, default: 'now()' },
      ],
      indexes: [{ name: 'email_templates_pkey', columns: ['id'], unique: true }],
    },
    reply_inbox: {
      columns: [
        { name: 'id',             type: 'integer', nullable: false, default: null },
        { name: 'classification', type: 'text',    nullable: true,  default: null },
        { name: 'handled',        type: 'boolean', nullable: true,  default: 'false' },
      ],
      indexes: [],
    },
  },
}

describe('S9 — Historical schema drift incidents (regression)', () => {
  it('INC: 2026-04-21 — outreach_mailboxes added password_encrypted column without BFF update', () => {
    const liveWithDrift = JSON.parse(JSON.stringify(baseManifest))
    liveWithDrift.tables.outreach_mailboxes = {
      columns: [
        { name: 'id', type: 'integer', nullable: false, default: null },
        { name: 'password_encrypted', type: 'bytea', nullable: true, default: null }, // NEW
      ],
      indexes: [],
    }
    liveWithDrift.manifest_hash = 'sha256:drift1'

    const diff = diffManifests(liveWithDrift, baseManifest)
    expect(diff.ok).toBe(false)
    expect(diff.drift.addedTables).toContain('outreach_mailboxes')
  })

  it('INC: column type change text → varchar(255) detected', () => {
    const driftedManifest = JSON.parse(JSON.stringify(baseManifest))
    driftedManifest.tables.email_templates.columns[1].type = 'character varying(255)'
    driftedManifest.manifest_hash = 'sha256:drift2'

    const diff = diffManifests(driftedManifest, baseManifest)
    expect(diff.ok).toBe(false)
    expect(diff.drift.modifiedTables.length).toBeGreaterThan(0)
    expect(diff.drift.modifiedTables[0].typeChanges.length).toBeGreaterThan(0)
  })

  it('INC: removed column (e.g. legacy field cleanup)', () => {
    const driftedManifest = JSON.parse(JSON.stringify(baseManifest))
    driftedManifest.tables.email_templates.columns = driftedManifest.tables.email_templates.columns.filter(
      (c: any) => c.name !== 'subject'
    )
    driftedManifest.manifest_hash = 'sha256:drift3'

    const diff = diffManifests(driftedManifest, baseManifest)
    expect(diff.ok).toBe(false)
    const modTable = diff.drift.modifiedTables.find((m: any) => m.name === 'email_templates')
    expect(modTable).toBeDefined()
    expect(modTable.removedCols).toContain('subject')
  })

  it('INC: added new table without BFF awareness', () => {
    const driftedManifest = JSON.parse(JSON.stringify(baseManifest))
    driftedManifest.tables.heal_quorum_votes = {
      columns: [{ name: 'id', type: 'integer', nullable: false, default: null }],
      indexes: [],
    }
    driftedManifest.manifest_hash = 'sha256:drift4'

    const diff = diffManifests(driftedManifest, baseManifest)
    expect(diff.ok).toBe(false)
    expect(diff.drift.addedTables).toContain('heal_quorum_votes')
  })

  it('INC: dropped table (data loss risk)', () => {
    const driftedManifest = JSON.parse(JSON.stringify(baseManifest))
    delete driftedManifest.tables.reply_inbox
    driftedManifest.manifest_hash = 'sha256:drift5'

    const diff = diffManifests(driftedManifest, baseManifest)
    expect(diff.ok).toBe(false)
    expect(diff.drift.removedTables).toContain('reply_inbox')
  })

  it('INC: nullable change (NOT NULL → nullable, breaking validation)', () => {
    const driftedManifest = JSON.parse(JSON.stringify(baseManifest))
    driftedManifest.tables.email_templates.columns[1].nullable = true  // name was NOT NULL
    driftedManifest.manifest_hash = 'sha256:drift6'

    const diff = diffManifests(driftedManifest, baseManifest)
    expect(diff.ok).toBe(false)
  })

  it('INC: index removed (perf regression risk)', () => {
    const driftedManifest = JSON.parse(JSON.stringify(baseManifest))
    driftedManifest.tables.email_templates.indexes = []
    driftedManifest.manifest_hash = 'sha256:drift7'

    // Index changes ALSO produce hash drift; quickCheck catches it
    expect(quickCheck(driftedManifest, baseManifest)).toBe(false)
  })

  it('NO drift: identical manifest → ok=true', () => {
    expect(diffManifests(baseManifest, baseManifest).ok).toBe(true)
    expect(quickCheck(baseManifest, baseManifest)).toBe(true)
  })

  it('NO drift: reordered keys are canonicalized → ok=true', () => {
    // Same content, different key order
    const reordered = {
      tables: { reply_inbox: baseManifest.tables.reply_inbox, email_templates: baseManifest.tables.email_templates },
      version: baseManifest.version,
      manifest_hash: baseManifest.manifest_hash,
    }
    expect(diffManifests(reordered, baseManifest).ok).toBe(true)
  })

  it('Cross-incident: 3 drifts at once detected as single composite drift', () => {
    const composite = JSON.parse(JSON.stringify(baseManifest))
    composite.tables.email_templates.columns[1].type = 'varchar(255)'
    delete composite.tables.reply_inbox
    composite.tables.new_table = { columns: [{ name: 'id', type: 'integer', nullable: false, default: null }], indexes: [] }
    composite.manifest_hash = 'sha256:composite'

    const diff = diffManifests(composite, baseManifest)
    expect(diff.ok).toBe(false)
    expect(diff.drift.addedTables.length).toBeGreaterThan(0)
    expect(diff.drift.removedTables.length).toBeGreaterThan(0)
    expect(diff.drift.modifiedTables.length).toBeGreaterThan(0)
  })

  it('Sentry tag would fire: drift outcome includes structured info for alert routing', () => {
    const driftedManifest = JSON.parse(JSON.stringify(baseManifest))
    driftedManifest.tables.email_templates.columns[1].type = 'varchar(100)'
    driftedManifest.manifest_hash = 'sha256:type-drift'

    const diff = diffManifests(driftedManifest, baseManifest)
    expect(diff.ok).toBe(false)
    // Operator dashboard should show:
    expect(diff.drift).toHaveProperty('addedTables')
    expect(diff.drift).toHaveProperty('removedTables')
    expect(diff.drift).toHaveProperty('modifiedTables')
    expect(diff.drift).toHaveProperty('hashMatch')
    expect(diff.drift.hashMatch).toBe(false)
  })

  it('Property: any column add → drift detected (10 random tables)', () => {
    for (let i = 0; i < 10; i++) {
      const drifted = JSON.parse(JSON.stringify(baseManifest))
      const tableName = i % 2 === 0 ? 'email_templates' : 'reply_inbox'
      drifted.tables[tableName].columns.push({
        name: `col_${i}`,
        type: 'text',
        nullable: true,
        default: null,
      })
      drifted.manifest_hash = `sha256:prop-${i}`
      expect(diffManifests(drifted, baseManifest).ok).toBe(false)
    }
  })
})
