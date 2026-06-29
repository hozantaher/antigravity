import type { Transaction } from 'kysely'
import type { Database } from '../db/schema'
import { db } from '../utils/db'
import { captureServerError } from '../utils/observability'

export interface AuditEntry {
  actorId: string | null
  action: string
  entity: string
  entityId: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  ip?: string | null
}

const toRow = (e: AuditEntry) => ({
  actorId: e.actorId,
  action: e.action,
  entity: e.entity,
  entityId: e.entityId,
  before: e.before ?? null,
  after: e.after ?? null,
  ip: e.ip ?? null,
})

// Best-effort: an audit failure must never break the admin action it records (the action has
// already been authorized and is the user's intent). Logged via observability instead.
export const writeAudit = async (entry: AuditEntry): Promise<void> => {
  try {
    await db.insertInto('auditLog').values(toRow(entry)).execute()
  } catch (e) {
    captureServerError(e, { area: 'audit.write', tags: { action: entry.action, entity: entry.entity } })
  }
}

// Transactional variant: writes the audit row inside the caller's transaction so the action and its
// audit commit atomically. Throws on failure (the caller's tx owns the error).
export const writeAuditInTx = (trx: Transaction<Database>, entry: AuditEntry): Promise<unknown> =>
  trx.insertInto('auditLog').values(toRow(entry)).execute()
