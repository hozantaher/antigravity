// run-scorecard.mjs — runs scripts/linkage-scorecard.sql against PROD and prints
// the linkage slack as an aligned table. The compass for the "Produkční raketa"
// loop: log these numbers every tick, watch the slack rows shrink.
//
// Usage:  pnpm scorecard            (DATABASE_URL loaded from .env)
//         pnpm scorecard --json     (machine-readable, for Δ diffing)
//         pnpm scorecard --log      (append a snapshot to the tick-log for
//                                     cross-tick / cross-session trend)
//         pnpm scorecard --diff     (show Δ of each slack/quality row vs the
//                                     last logged snapshot — "what changed since
//                                     last tick" at a glance)

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const sql = readFileSync(join(here, 'linkage-scorecard.sql'), 'utf8')
const asJson = process.argv.includes('--json')
const doLog = process.argv.includes('--log')
const doDiff = process.argv.includes('--diff')

/** Last logged snapshot's slack map (or null if none / unreadable). */
function lastLoggedSlack(logPath) {
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    if (!lines.length) return null
    return JSON.parse(lines[lines.length - 1]).slack || null
  } catch { return null }
}
// Local tick-log (reports/ is gitignored — fine, the loop runs local-only so the
// file persists across ticks/sessions on the operator's machine). One JSONL line
// per `--log` run → the loop's memory of the slack trend instead of re-deriving.
const LOG_PATH = join(here, '..', 'reports', 'scorecard-log.jsonl')

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL not set — run via `pnpm scorecard` (loads .env) or export it.')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: url })
try {
  const { rows } = await pool.query(sql)
  if (doLog) {
    const slack = {}
    for (const r of rows) if (!r.metric.startsWith('(total)')) slack[r.metric] = Number(r.n)
    const line = JSON.stringify({ ts: new Date().toISOString(), slack }) + '\n'
    try {
      mkdirSync(dirname(LOG_PATH), { recursive: true })
      appendFileSync(LOG_PATH, line)
    } catch (e) {
      console.error('scorecard tick-log append failed:', e?.message || e)
    }
  }
  if (doDiff) {
    const prev = lastLoggedSlack(LOG_PATH)
    const w = Math.max(...rows.map(r => r.metric.length))
    process.stdout.write('\nSCORECARD Δ  (vs last logged snapshot)\n')
    process.stdout.write('─'.repeat(w + 20) + '\n')
    if (!prev) {
      process.stdout.write('(no prior snapshot — run `pnpm scorecard:log` first)\n\n')
    } else {
      for (const r of rows) {
        if (r.metric.startsWith('(total)')) continue
        const cur = Number(r.n)
        const old = prev[r.metric]
        if (old === undefined) {
          process.stdout.write(`${r.metric.padEnd(w)}  ${String(cur).padStart(6)}  (new)\n`)
          continue
        }
        const d = cur - old
        const arrow = d === 0 ? '  =' : (d < 0 ? `  ↓${-d} (lepší)` : `  ↑${d} (horší)`)
        process.stdout.write(`${r.metric.padEnd(w)}  ${String(cur).padStart(6)}${arrow}\n`)
      }
    }
    process.stdout.write('\n')
  } else if (asJson) {
    process.stdout.write(JSON.stringify(rows.map(r => ({ metric: r.metric, n: Number(r.n) }))) + '\n')
  } else {
    const w = Math.max(...rows.map(r => r.metric.length))
    process.stdout.write('\nLINKAGE SCORECARD  (slack rows: lower = better)\n')
    process.stdout.write('─'.repeat(w + 12) + '\n')
    for (const r of rows) {
      const isTotal = r.metric.startsWith('(total)')
      const n = String(r.n).padStart(7)
      process.stdout.write(`${r.metric.padEnd(w)}  ${n}${isTotal ? '' : (Number(r.n) === 0 ? '  ✓' : '')}\n`)
    }
    process.stdout.write('\n')
  }
} catch (e) {
  console.error('scorecard query failed:', e?.message || e)
  process.exitCode = 1
} finally {
  await pool.end()
}
