import { Kysely, PostgresDialect, CamelCasePlugin } from 'kysely'
import { Pool } from 'pg'
import { Resolver, lookup as dnsLookup } from 'dns'
import type { LookupOneOptions } from 'dns'
import type { Database } from '../db/schema'

export type { Database } from '../db/schema'

// Static reference data stays config (not DB-backed); re-export so the
// reference endpoints keep getting it via Nitro auto-imports.
export { categories, categoryParams, countries, currencies, languages, EUR, CZK } from '../data/fixtures'

const connectionString = process.env.POSTGRES_URL

if (!connectionString) {
  throw new Error('POSTGRES_URL is not set in environment')
}

// Railway PG proxy uses a self-signed cert; override via POSTGRES_SSL=disable.
const useSsl = process.env.POSTGRES_SSL !== 'disable'

// systemd-resolved is flaky for Railway proxy hostnames; fall back to public DNS
// on ENOTFOUND/ESERVFAIL. Local Resolver instead of dns.setServers to avoid
// leaking into unrelated lookups in the process.
const fallbackResolver = new Resolver()
fallbackResolver.setServers(['8.8.8.8', '1.1.1.1'])

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void

const robustLookup = (
  hostname: string,
  options: LookupOneOptions | LookupCallback,
  callback?: LookupCallback,
): void => {
  const cb = (typeof options === 'function' ? options : callback) as LookupCallback
  const opts: LookupOneOptions = typeof options === 'function' ? {} : options
  dnsLookup(hostname, opts, (err, address, family) => {
    if (!err) return cb(null, address, family)
    fallbackResolver.resolve4(hostname, (e2, addrs) => {
      if (e2 || !addrs?.length) return cb(err, '', 0)
      cb(null, addrs[0]!, 4)
    })
  })
}

// Per-statement caps protect the request path from runaway queries. Batch/CLI work
// (migrations building GIN indexes, bulk Firestore import, seed) legitimately runs much
// longer, so the CLI scripts set POSTGRES_STATEMENT_TIMEOUT=0 before importing this module
// — pg treats 0 as "no timeout" — to avoid a partially-applied migration on large tables.
const statementTimeoutMs = Number(process.env.POSTGRES_STATEMENT_TIMEOUT ?? 15_000)

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  // App Hosting runs several instances; max × instances must stay under Railway PG's
  // connection cap. Idle connections are released so they don't pin slots, a slow
  // connect fails fast, and statement_timeout caps any single runaway query.
  max: Number(process.env.POSTGRES_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
  statement_timeout: statementTimeoutMs,
  query_timeout: statementTimeoutMs,
  // @ts-expect-error pg types don't expose `lookup`, but Pool forwards it to net.connect
  lookup: robustLookup,
})

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
  plugins: [new CamelCasePlugin()],
})

export const destroyDb = async (): Promise<void> => {
  await db.destroy()
}
