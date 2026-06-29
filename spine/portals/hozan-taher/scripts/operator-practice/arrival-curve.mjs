#!/usr/bin/env node
/**
 * arrival-curve.mjs — generate reply-arrival timeline (OP2.1).
 *
 * Outputs JSON array `[{delay_ms, fixture_category, index}]` matching
 * a typical B2B reply distribution: front-loaded with long tail.
 *
 * Distribution model (default):
 *   t = 0h:    1% (immediate auto-replies + OOO)
 *   t = 0–1h:  +9% (early reads, fast no-thanks)
 *   t = 1–4h:  +25% (lunch, afternoon read)
 *   t = 4–24h: +35% (next-morning read)
 *   t = 1–3d:  +20% (delayed but still inbound)
 *   t = 3–7d:  +10% (long-tail OOO returns, late catches)
 *
 * The model is a piecewise CDF; sampled deterministically by index when
 * --seed is set (default seed: 'op-practice-2026'). Deterministic seed
 * means tests/CI can reproduce exact curves.
 *
 * Usage:
 *   node arrival-curve.mjs --campaign-size 50 --duration-h 168 [--seed X]
 *   node arrival-curve.mjs --campaign-size 50 --duration-h 168 --output curve.json
 *   node arrival-curve.mjs --self-test
 *
 * Per memory feedback_no_speculation: distribution numbers above are
 * placeholder defaults until prod replies measured. Replace with measured
 * curve via --bucket flag once data available.
 */

import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// ── Distribution model ───────────────────────────────────────────────

const DEFAULT_BUCKETS = [
  { upToHours: 0,   share: 0.01 },  // immediate
  { upToHours: 1,   share: 0.10 },  // 0..1h cumulative
  { upToHours: 4,   share: 0.35 },  // 0..4h cumulative
  { upToHours: 24,  share: 0.70 },  // 0..24h cumulative
  { upToHours: 72,  share: 0.90 },  // 0..3d cumulative
  { upToHours: 168, share: 1.00 },  // 0..7d cumulative
]

const CATEGORIES = ['interested', 'not-interested', 'ooo', 'wrong-person', 'spam', 'ambiguous']

// Approximate distribution of categories per real B2B reply traffic
// (defaults, replace with measured values when prod export landed).
const CATEGORY_WEIGHTS = {
  'interested': 0.10,
  'not-interested': 0.40,
  'ooo': 0.20,
  'wrong-person': 0.05,
  'spam': 0.10,
  'ambiguous': 0.15,
}

// ── Pure helpers ─────────────────────────────────────────────────────

export function deterministicRandom(seed, index) {
  const hash = createHash('sha256').update(`${seed}:${index}`).digest('hex')
  // Take 8 hex chars → uint32 → normalize to [0, 1)
  return parseInt(hash.slice(0, 8), 16) / 0x100000000
}

export function pickDelayHours(buckets, r) {
  // r in [0,1). Find bucket whose cumulative share ≥ r.
  let prevH = 0
  let prevShare = 0
  for (const b of buckets) {
    if (r < b.share) {
      // Linearly interpolate within bucket
      const frac = (r - prevShare) / Math.max(b.share - prevShare, 1e-9)
      return prevH + frac * (b.upToHours - prevH)
    }
    prevH = b.upToHours
    prevShare = b.share
  }
  // Past 100% (shouldn't hit but defensive)
  return buckets[buckets.length - 1].upToHours
}

export function pickCategory(weights, r) {
  let cum = 0
  for (const cat of Object.keys(weights)) {
    cum += weights[cat]
    if (r < cum) return cat
  }
  return Object.keys(weights).at(-1)
}

export function generateCurve({ campaignSize, durationH, seed = 'op-practice-2026', buckets = DEFAULT_BUCKETS, weights = CATEGORY_WEIGHTS }) {
  if (!Number.isFinite(campaignSize) || campaignSize <= 0) {
    throw new Error('campaignSize must be > 0')
  }
  if (!Number.isFinite(durationH) || durationH <= 0) {
    throw new Error('durationH must be > 0')
  }
  // Cap buckets by durationH so a 1h replay doesn't generate 7d delays
  const cappedBuckets = buckets.map((b) => ({ ...b, upToHours: Math.min(b.upToHours, durationH) }))

  const out = []
  for (let i = 0; i < campaignSize; i++) {
    const rDelay = deterministicRandom(seed, `delay-${i}`)
    const rCat = deterministicRandom(seed, `cat-${i}`)
    const delayHours = pickDelayHours(cappedBuckets, rDelay)
    const delayMs = Math.round(delayHours * 3600 * 1000)
    out.push({
      index: i,
      delay_ms: delayMs,
      fixture_category: pickCategory(weights, rCat),
    })
  }
  // Sort by delay so replay loops can iterate in order
  out.sort((a, b) => a.delay_ms - b.delay_ms)
  return out
}

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    campaignSize: 50,
    durationH: 168,
    seed: 'op-practice-2026',
    output: null,
    selfTest: false,
    help: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    switch (a) {
      case '--campaign-size': out.campaignSize = parseInt(v, 10); i++; break
      case '--duration-h': out.durationH = parseFloat(v); i++; break
      case '--seed': out.seed = v; i++; break
      case '--output': out.output = v; i++; break
      case '--self-test': out.selfTest = true; break
      case '--help': case '-h': out.help = true; break
      default:
        if (a.startsWith('--')) {
          throw new Error(`unknown arg: ${a}`)
        }
    }
  }
  return out
}

function printHelp() {
  console.log(`Usage: arrival-curve.mjs --campaign-size N --duration-h H [opts]

Generates a deterministic reply-arrival timeline for replay tools.

Options:
  --campaign-size N    Number of replies to schedule (default: 50)
  --duration-h H       Duration in hours from t=0 (default: 168 = 7d)
  --seed S             Deterministic seed (default: op-practice-2026)
  --output PATH        Write JSON to file (default: stdout)
  --self-test          Run inline tests + exit
  --help               This message

Output format:
  [
    { "index": 0, "delay_ms": 0, "fixture_category": "ooo" },
    { "index": 1, "delay_ms": 320000, "fixture_category": "interested" },
    ...
  ]

Sorted ascending by delay_ms. Distribution per piecewise CDF (front-loaded
with long tail). See script header for bucket weights.

Exit: 0 ok / 1 IO / 2 self-test fail / 3 args`)
}

function selfTest() {
  const tests = [
    {
      name: 'deterministicRandom returns [0,1)',
      run: () => {
        const r = deterministicRandom('seed', 0)
        return r >= 0 && r < 1
      },
    },
    {
      name: 'deterministicRandom is deterministic',
      run: () => deterministicRandom('seed', 42) === deterministicRandom('seed', 42),
    },
    {
      name: 'deterministicRandom different seeds → different values',
      run: () => deterministicRandom('a', 0) !== deterministicRandom('b', 0),
    },
    {
      name: 'pickDelayHours boundary at 0%',
      run: () => pickDelayHours(DEFAULT_BUCKETS, 0) === 0,
    },
    {
      name: 'pickDelayHours boundary at 100%',
      run: () => pickDelayHours(DEFAULT_BUCKETS, 0.999999) <= 168,
    },
    {
      name: 'pickCategory returns valid category',
      run: () => CATEGORIES.includes(pickCategory(CATEGORY_WEIGHTS, 0.5)),
    },
    {
      name: 'generateCurve returns N items',
      run: () => generateCurve({ campaignSize: 25, durationH: 24 }).length === 25,
    },
    {
      name: 'generateCurve sorted ascending',
      run: () => {
        const c = generateCurve({ campaignSize: 50, durationH: 24 })
        for (let i = 1; i < c.length; i++) if (c[i].delay_ms < c[i - 1].delay_ms) return false
        return true
      },
    },
    {
      name: 'generateCurve deterministic with same seed',
      run: () => {
        const a = generateCurve({ campaignSize: 10, durationH: 24, seed: 's' })
        const b = generateCurve({ campaignSize: 10, durationH: 24, seed: 's' })
        return JSON.stringify(a) === JSON.stringify(b)
      },
    },
    {
      name: 'generateCurve respects durationH cap',
      run: () => {
        const c = generateCurve({ campaignSize: 100, durationH: 1 })
        return c.every((e) => e.delay_ms <= 60 * 60 * 1000)
      },
    },
  ]
  let pass = 0, fail = 0
  for (const t of tests) {
    try {
      if (t.run()) { console.log(`  ✓ ${t.name}`); pass++ }
      else { console.log(`  ✗ ${t.name}`); fail++ }
    } catch (e) {
      console.log(`  ✗ ${t.name} threw: ${e.message}`)
      fail++
    }
  }
  console.log(`\n${pass}/${pass + fail} pass`)
  return fail === 0
}

async function main() {
  let args
  try { args = parseArgs(process.argv) }
  catch (e) { console.error(e.message); process.exit(3) }

  if (args.help) { printHelp(); return }
  if (args.selfTest) { process.exit(selfTest() ? 0 : 2) }

  let curve
  try { curve = generateCurve(args) }
  catch (e) { console.error(e.message); process.exit(3) }

  const json = JSON.stringify(curve, null, 2)
  if (args.output) {
    try { writeFileSync(args.output, json) }
    catch (e) { console.error(`write ${args.output}: ${e.message}`); process.exit(1) }
    console.error(`wrote ${curve.length} entries → ${args.output}`)
  } else {
    process.stdout.write(json)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
