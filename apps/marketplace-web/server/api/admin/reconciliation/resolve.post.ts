import { dismissFioPayment, type FioAccount } from '~/server/repos/reconRepo'
import { writeAudit } from '~/server/repos/auditRepo'
import { ipFromEvent } from '~/server/utils/rateLimit'

// Dismiss an unmatched Fio movement (handled off-system / refunded) so it leaves the queue. The row
// is kept; the dismissal is audited. CAS on 'unmatched' status guards against a concurrent settle.
export default defineEventHandler(async event => {
  const admin = await requireAdmin(event)
  const body = await readBody<{ account?: string; fioId?: string; note?: string }>(event)
  const account = body?.account
  const fioId = body?.fioId
  if ((account !== 'CZK' && account !== 'EUR') || !fioId) {
    throw createError({ statusCode: 422, statusMessage: 'account (CZK|EUR) and fioId are required' })
  }
  const dismissed = await dismissFioPayment(account as FioAccount, fioId)
  if (!dismissed) throw createError({ statusCode: 404, statusMessage: 'No unmatched movement for that id' })
  await writeAudit({
    actorId: admin.id,
    action: 'reconciliation.dismiss',
    entity: 'fioPayment',
    entityId: `${account}:${fioId}`,
    after: { status: 'dismissed', note: body?.note ?? null },
    ip: ipFromEvent(event),
  })
  return { ok: true }
})
