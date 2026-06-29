#!/usr/bin/env tsx
import { loadEnv } from './load-env'

loadEnv()
process.env.POSTGRES_STATEMENT_TIMEOUT ??= '0'

const main = async (): Promise<void> => {
  const { db, destroyDb } = await import('../server/utils/db')
  try {
    const rows = await db
      .selectFrom('items')
      .select(['id', 'internalId', 'title', 'type', 'categoryId', 'sold', 'hidden', 'closed'])
      .execute()
    const visible = rows.filter(r => !r.hidden)
    console.log(JSON.stringify({ total: rows.length, visible: visible.length, rows }, null, 0))
  } finally {
    await destroyDb()
  }
}

main()
