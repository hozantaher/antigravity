#!/usr/bin/env tsx
// One-off: remove the seeded fixture listings (i1–i16) from the live DB.
// Bids cascade on item delete. Pass `--apply` to actually delete; default is a
// dry run that only reports what is present.
import { buildItems } from '../server/data/fixtures'
import { loadEnv } from './load-env'

loadEnv()
process.env.POSTGRES_STATEMENT_TIMEOUT ??= '0'

const apply = process.argv.includes('--apply')

const main = async () => {
  const { db, destroyDb } = await import('../server/utils/db')
  const ids = buildItems().map(i => i.id)

  try {
    const present = await db.selectFrom('items').select('id').where('id', 'in', ids).execute()

    console.log(`Fixture items present in DB: ${present.length}/${ids.length}`)
    if (present.length) console.log(present.map(r => r.id).join(', '))

    if (!apply) {
      console.log('\nDry run — re-run with --apply to delete.')
      return
    }
    if (!present.length) {
      console.log('Nothing to delete.')
      return
    }

    const res = await db.deleteFrom('items').where('id', 'in', ids).executeTakeFirst()
    console.log(`Deleted ${res.numDeletedRows ?? 0n} items (bids cascaded).`)
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    await destroyDb()
  }
}

main()
