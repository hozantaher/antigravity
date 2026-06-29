import type { Paginated } from '~/models'
import { db } from '../utils/db'
import { paginate, type PageParams } from '../utils/pagination'

export type FioAccount = 'CZK' | 'EUR'

// A bank movement the Fio cron pulled but could not tie to an open invoice (wrong/zero VS, off
// amount, foreign payment). It persists with matched_invoice_id NULL + status 'unmatched' — this is
// the manual reconciliation queue. Heavy `raw` payload is left out of the projection.
export interface FioMovement {
  account: FioAccount
  fioId: string
  amount: string
  currency: string
  vs: string | null
  counterAccount: string | null
  counterName: string | null
  message: string | null
  paidOn: number
  status: string
}

interface FioRow {
  account: FioAccount
  fioId: string
  amount: string
  currency: string
  vs: string | null
  counterAccount: string | null
  counterName: string | null
  message: string | null
  paidOn: Date
  status: string
}

const rowToMovement = (r: FioRow): FioMovement => ({
  account: r.account,
  fioId: r.fioId,
  amount: r.amount,
  currency: r.currency,
  vs: r.vs,
  counterAccount: r.counterAccount,
  counterName: r.counterName,
  message: r.message,
  paidOn: r.paidOn.getTime(),
  status: r.status,
})

// The reconciliation queue: unmatched movements not yet dismissed, newest first.
export const listUnmatchedFioPayments = (params: PageParams): Promise<Paginated<FioMovement>> =>
  paginate(
    db.selectFrom('fioPayments').where('matchedInvoiceId', 'is', null).where('status', '=', 'unmatched'),
    qb => qb.orderBy('paidOn', 'desc').orderBy('fioId', 'desc'),
    rows => rows.map(r => rowToMovement(r as FioRow)),
    params,
    qb =>
      qb.select([
        'account',
        'fioId',
        'amount',
        'currency',
        'vs',
        'counterAccount',
        'counterName',
        'message',
        'paidOn',
        'status',
      ]),
  )

// Mark a movement reviewed (handled off-system / refunded) so it leaves the queue. CAS on the
// 'unmatched' status so a concurrent cron settle can't be clobbered. Returns true when it flipped.
export const dismissFioPayment = async (account: FioAccount, fioId: string): Promise<boolean> => {
  const res = await db
    .updateTable('fioPayments')
    .set({ status: 'dismissed' })
    .where('account', '=', account)
    .where('fioId', '=', fioId)
    .where('status', '=', 'unmatched')
    .executeTakeFirst()
  return Number(res.numUpdatedRows ?? 0) > 0
}
