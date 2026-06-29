import type { Invoice, Paginated } from '~/models'
import { db } from '../utils/db'
import { rowToInvoice } from './mappers'
import { paginate, type PageParams } from '../utils/pagination'

export const listForUserPage = (userId: string, params: PageParams): Promise<Paginated<Invoice>> =>
  paginate(
    db.selectFrom('invoices').where('userId', '=', userId),
    qb => qb.orderBy('createdDate', 'desc').orderBy('id', 'asc'),
    rows => rows.map(rowToInvoice),
    params,
  )
