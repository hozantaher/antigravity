// dns-prefilter-companies.mjs
// ─────────────────────────────────────────────────────────────────────────
// DNS-only company email pre-filter. ZERO reputation cost — no SMTP probe,
// no email sent, only DNS (MX/A) lookups + pure pattern checks.
//
// Marks prokazatelně-undeliverable companies in companies.email_status:
//   bad syntax / disposable / dangerous-role / no-MX  → 'invalid'
//   spamtrap pattern                                    → 'spamtrap'
// Survivors (valid syntax + has MX + not junk) are LEFT email_status empty
// (DNS cannot confirm a mailbox exists — that needs RCPT/3rd-party), but are
// stamped email_verified_at + email_verification='dns_ok_no_probe' so they are
// (a) not re-processed and (b) discoverable as the "probe-worthy" subset.
//
// Runner gate is companies.email_status='valid' — this script never writes
// 'valid', so it cannot increase what gets sent; it only removes junk and
// scopes the candidate set. Safe + resumable + idempotent.
//
// Usage:
//   DATABASE_URL=... node dns-prefilter-companies.mjs --dry-run --limit 500
//   DATABASE_URL=... node dns-prefilter-companies.mjs            # full run
// ─────────────────────────────────────────────────────────────────────────
import dns from 'dns/promises'
import pg from 'pg'
import { validateSyntax, isDisposable, isSpamtrap, roleCategory } from '../src/lib/emailVerify.js'

const DRY = process.argv.includes('--dry-run')
const li = process.argv.indexOf('--limit')
const LIMIT = li > -1 ? Number(process.argv[li + 1]) : Infinity
const BATCH = 2000
const CONCURRENCY = 30
const MX_TIMEOUT_MS = 5000
// DNS retry (T0 feedback_external_io_backoff: exponential backoff + jitter on
// every external lookup). A transient failure must NOT be mistaken for a
// definitive "no mail" verdict — see domainMailState()/classify().
const DNS_MAX_ATTEMPTS = 3
const DNS_BACKOFF_BASE_MS = 200

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(1) }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 })

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ENOTFOUND (NXDOMAIN) / ENODATA (no record of that type) are DEFINITIVE
// negatives — the domain genuinely has no such record. Everything else
// (timeout, ESERVFAIL, EREFUSED, network) is transient: retry, and if it still
// fails, report 'unknown' rather than poisoning the row as permanently invalid.
const isDefinitiveDnsMiss = (e) => !!e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')

// One DNS query: timeout + exponential backoff + jitter on transient errors.
// Throws the last error (definitive misses are not retried).
async function dnsQuery(fn) {
  let lastErr
  for (let attempt = 0; attempt < DNS_MAX_ATTEMPTS; attempt++) {
    try { return await withTimeout(fn(), MX_TIMEOUT_MS) }
    catch (e) {
      lastErr = e
      if (isDefinitiveDnsMiss(e)) throw e
      if (attempt < DNS_MAX_ATTEMPTS - 1) {
        const backoff = DNS_BACKOFF_BASE_MS * 2 ** attempt
        await sleep(backoff + Math.random() * backoff) // full jitter
      }
    }
  }
  throw lastErr
}

// Per-domain mail-capability cache — MX is a domain property, dedupe across
// companies. Returns 'yes' | 'no' | 'unknown'. 'unknown' is NOT cached so a
// transient blip is re-checked on the next run instead of sticking forever.
const mxCache = new Map() // domain -> 'yes' | 'no'
async function domainMailState(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain)
  let state
  try {
    const mx = await dnsQuery(() => dns.resolveMx(domain))
    state = Array.isArray(mx) && mx.length > 0 ? 'yes' : 'no'
  } catch (e) {
    if (!isDefinitiveDnsMiss(e)) {
      state = 'unknown' // transient after retries — do not poison the row
    } else {
      // No MX record — some domains still accept mail on an A record. Only a
      // definitive A-miss makes this 'no'; a transient A-failure is 'unknown'.
      try {
        const a = await dnsQuery(() => dns.resolve4(domain))
        state = Array.isArray(a) && a.length > 0 ? 'yes' : 'no'
      } catch (e2) {
        state = isDefinitiveDnsMiss(e2) ? 'no' : 'unknown'
      }
    }
  }
  if (state !== 'unknown') mxCache.set(domain, state)
  return state
}

// DNS-only classification → status to WRITE, or null = survivor (leave empty).
async function classify(email) {
  const syn = validateSyntax(email)
  if (!syn.ok) return { status: 'invalid', detail: `syntax:${syn.reason}` }
  if (isSpamtrap(email)) return { status: 'spamtrap', detail: 'spamtrap_pattern' }
  if (isDisposable(syn.domain)) return { status: 'invalid', detail: 'disposable' }
  if (roleCategory(syn.local) === 'dangerous') return { status: 'invalid', detail: 'role_dangerous' }
  const mail = await domainMailState(syn.domain)
  if (mail === 'unknown') return { status: 'unknown', detail: 'dns_transient' } // leave row untouched, retry later
  if (mail === 'no') return { status: 'invalid', detail: 'no_mx' }
  return null // survivor
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) }
  }))
  return out
}

async function run() {
  console.log(`[dns-prefilter] start dry=${DRY} limit=${LIMIT === Infinity ? 'all' : LIMIT}`)
  const tally = { invalid: 0, spamtrap: 0, survivor: 0, unknown: 0, processed: 0 }
  // Keyset cursor on ico so forward progress is made even in --dry-run, where
  // rows are not stamped email_verified_at and the IS NULL filter alone would
  // return the same first BATCH forever (infinite loop). Also required now that
  // transient 'unknown' rows are left unstamped — without the cursor they would
  // re-match every batch in the non-dry path too.
  let cursorIco = ''
  for (;;) {
    if (tally.processed >= LIMIT) break
    const take = Math.min(BATCH, LIMIT - tally.processed)
    const { rows } = await pool.query(
      `SELECT ico, email FROM companies
        WHERE email IS NOT NULL AND email <> ''
          AND (email_status IS NULL OR email_status = '')
          AND email_verified_at IS NULL
          AND ico > $2
        ORDER BY ico LIMIT $1`, [take, cursorIco])
    if (!rows.length) break
    cursorIco = rows[rows.length - 1].ico

    const results = await mapLimit(rows, CONCURRENCY, async (r) => ({ ico: r.ico, c: await classify(r.email) }))

    // 'unknown' = transient DNS failure → leave the row entirely untouched so it
    // is re-examined on a later run (never permanently marked invalid on a blip).
    const bad = results.filter(r => r.c && r.c.status !== 'unknown') // get a status written
    const survivors = results.filter(r => !r.c)                      // stay empty, stamped checked
    const unknown = results.filter(r => r.c && r.c.status === 'unknown')
    tally.invalid  += bad.filter(b => b.c.status === 'invalid').length
    tally.spamtrap += bad.filter(b => b.c.status === 'spamtrap').length
    tally.survivor += survivors.length
    tally.unknown  += unknown.length
    tally.processed += rows.length

    if (!DRY) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // One UPDATE per distinct (status, detail) pair so each row keeps its
        // true reason — a no-MX company must not be stamped 'disposable' just
        // because another row in the same batch happened to be disposable.
        const byReason = new Map() // key -> { status, detail, icos: [] }
        for (const b of bad) {
          const key = `${b.c.status} ${b.c.detail}`
          let g = byReason.get(key)
          if (!g) { g = { status: b.c.status, detail: b.c.detail, icos: [] }; byReason.set(key, g) }
          g.icos.push(b.ico)
        }
        for (const { status, detail, icos } of byReason.values()) {
          await client.query(
            `UPDATE companies SET email_status=$1, email_verified_at=now(),
                    email_verification=$2 WHERE ico = ANY($3)`,
            [status, `dns_prefilter:${detail}`, icos])
        }
        if (survivors.length) {
          await client.query(
            `UPDATE companies SET email_verified_at=now(), email_verification='dns_ok_no_probe'
              WHERE ico = ANY($1)`, [survivors.map(s => s.ico)])
        }
        await client.query('COMMIT')
      } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    }
    console.log(`[dns-prefilter] processed=${tally.processed} invalid=${tally.invalid} spamtrap=${tally.spamtrap} survivor(probe-worthy)=${tally.survivor} unknown(transient)=${tally.unknown} domains_cached=${mxCache.size}`)
  }

  if (!DRY && tally.processed > 0) {
    await pool.query(
      `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
       VALUES ('companies_dns_prefilter','dns-prefilter-script','companies', NULL, $1)`,
      [JSON.stringify(tally)])
  }
  console.log(`[dns-prefilter] DONE`, tally)
  await pool.end()
}
run().catch(e => { console.error('[dns-prefilter] FATAL', e); process.exit(1) })
