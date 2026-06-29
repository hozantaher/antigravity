#!/usr/bin/env tsx
// CLI entry for kysely migrations. Usage:
//   pnpm db:migrate up
//   pnpm db:migrate down
//   pnpm db:migrate status
import { loadEnv } from './load-env'

loadEnv()
// Batch work: opt out of the request-path statement timeout (index builds exceed it).
process.env.POSTGRES_STATEMENT_TIMEOUT ??= '0'

const main = async () => {
  const { migrateUp, migrateDown, migrateStatus } = await import('../server/utils/migrate')
  const { destroyDb } = await import('../server/utils/db')

  const cmd = process.argv[2]
  try {
    if (cmd === 'up') await migrateUp()
    else if (cmd === 'down') await migrateDown()
    else if (cmd === 'status') await migrateStatus()
    else {
      console.error('Usage: db:migrate <up|down|status>')
      process.exitCode = 1
    }
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    await destroyDb()
  }
}

main()
