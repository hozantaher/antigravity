import type { H3Event } from 'h3'
import type { Selectable, SelectQueryBuilder } from 'kysely'
import type { Paginated } from '~/models'

export interface PageParams {
  page: number
  pageSize: number
  limit: number
  offset: number
}

interface PageOpts {
  defaultPageSize?: number
  maxPageSize?: number
}

const toInt = (value: unknown, fallback: number): number => {
  const n = Number(Array.isArray(value) ? value[0] : value)
  // Number('') and Number('0') are 0, so require >= 1: an empty or zero ?page/?pageSize must
  // use the fallback, not collapse to 1 (which would serve a single item per page).
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

// Read + clamp ?page / ?pageSize. pageSize is client-tunable (handy for testing
// many pages over a small dataset) but capped so a request can't ask for everything.
export const parsePageParams = (event: H3Event, opts: PageOpts = {}): PageParams => {
  const { defaultPageSize = 24, maxPageSize = 100 } = opts
  const q = getQuery(event)
  const page = Math.max(1, toInt(q.page, 1))
  const pageSize = Math.min(maxPageSize, Math.max(1, toInt(q.pageSize, defaultPageSize)))
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize }
}

// Total count and the page rows share one filtered `base` (same WHERE) and run in
// parallel. `order` sorts the page query; `map` turns the page rows into T (sync or
// async). One place owns the Paginated shape and the count string→number coercion.
export const paginate = async <DB, TB extends keyof DB, O, T>(
  base: SelectQueryBuilder<DB, TB, O>,
  order: (qb: SelectQueryBuilder<DB, TB, O>) => SelectQueryBuilder<DB, TB, O>,
  map: (rows: Selectable<DB[TB]>[]) => T[] | Promise<T[]>,
  { page, pageSize, limit, offset }: PageParams,
  // Row projection, defaults to selectAll. List queries pass an explicit column subset so heavy
  // JSONB/array columns stay out of the payload; `map` still receives them typed as full rows.
  select: (qb: SelectQueryBuilder<DB, TB, O>) => SelectQueryBuilder<DB, TB, O> = qb => qb.selectAll(),
): Promise<Paginated<T>> => {
  const [count, rows] = await Promise.all([
    base.select(eb => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
    select(order(base)).limit(limit).offset(offset).execute(),
  ])
  const total = Number((count as { total: string }).total)
  return { items: await map(rows as Selectable<DB[TB]>[]), total, page, pageSize }
}
