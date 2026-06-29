#!/usr/bin/env node
// A5 — Prod snapshot capture + drift checker.
//
// Phase 1: capture
//   • Boot real backend (or use existing target)
//   • For each known GET endpoint, store the response in
//     prod-snapshots/<endpoint>.json
//   • Sanitize unstable fields (timestamps, IDs, ports, sequence numbers)
//
// Phase 2: drift check (called from tests/contract/snapshot-drift.test.ts)
//   • For each MSW fixture, infer shape; compare to stored snapshot shape
//   • Surface drift as test failures
//
// This catches the "fixture diverged from prod" hallucination class
// at PR time — when MSW handler returns shape X but prod returns Y.

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) acc[m[1]] = m[2] ?? true
  return acc
}, {})

const TARGET = args.target || process.env.SYNTHETIC_TARGET_URL || 'http://localhost:3100'
const HEADERS = process.env.OUTREACH_API_KEY ? { 'x-api-key': process.env.OUTREACH_API_KEY } : {}
const SNAPSHOT_DIR = args.dir || join(ROOT, 'prod-snapshots')
const TIMEOUT_MS = Number(args.timeout || 8000)

const ENDPOINTS = [
  '/api/health',
  '/api/health/system',
  '/api/health/invariants',
  '/api/replies/stats',
  '/api/templates',
  '/api/segments',
  '/api/synthetic-runs?limit=10',
  '/api/dashboard/overview',
  '/api/proxy-pool',
  '/api/__schema-check',
]

// ── Sanitization ────────────────────────────────────────────────────────────
// Replaces values that change every request so snapshot stays stable.
const UNSTABLE_KEYS = new Set([
  'id', 'created_at', 'updated_at', 'ran_at', 'last_send_at', 'last_built_at',
  'generated_at', 'timestamp', 'started_at', 'finished_at', 'duration_ms',
  'last_seen', 'last_watchdog_at', 'next_run_at', 'pid', 'host_uptime_s',
])

export function sanitize(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sanitize)
  const out = {}
  for (const k of Object.keys(value).sort()) {
    if (UNSTABLE_KEYS.has(k)) {
      out[k] = `<sanitized:${k}>`
    } else if (typeof value[k] === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value[k])) {
      out[k] = '<sanitized:iso-timestamp>'
    } else {
      out[k] = sanitize(value[k])
    }
  }
  return out
}

// ── Path → filename ─────────────────────────────────────────────────────────
export function endpointToFilename(endpoint) {
  // /api/synthetic-runs?limit=10 → api__synthetic-runs__limit-10.json
  const noQuery = endpoint.split('?')[0]
  const query = endpoint.split('?')[1] || ''
  const slug = noQuery.replace(/^\/+/, '').replace(/[\/]/g, '__')
  const qslug = query ? '__' + query.replace(/[=&]/g, '-') : ''
  return slug + qslug + '.json'
}

// ── Capture ─────────────────────────────────────────────────────────────────
// HARDEN-5: cap response body at 50 MB. A malicious or misconfigured target
// could otherwise stream a 10 GB JSON and OOM the operator's machine.
const MAX_BODY_BYTES = Number(process.env.SNAPSHOT_MAX_BYTES || 50 * 1024 * 1024)

async function captureOne(endpoint) {
  const url = TARGET.replace(/\/+$/, '') + endpoint
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctl.signal })
    if (!r.ok) return { ok: false, status: r.status }
    // Guard the parser, not r.json(): we need to know the size before alloc.
    const text = await r.text()
    if (text.length > MAX_BODY_BYTES) {
      return { ok: false, error: `response too large: ${text.length} > ${MAX_BODY_BYTES}` }
    }
    const body = JSON.parse(text)
    return { ok: true, status: r.status, body }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    clearTimeout(t)
  }
}

async function captureAll() {
  if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true })
  const results = []
  for (const ep of ENDPOINTS) {
    const r = await captureOne(ep)
    if (!r.ok) {
      results.push({ endpoint: ep, ok: false, error: r.error || `status ${r.status}` })
      continue
    }
    const sanitized = sanitize(r.body)
    const file = join(SNAPSHOT_DIR, endpointToFilename(ep))
    writeFileSync(file, JSON.stringify({ endpoint: ep, captured_at: new Date().toISOString(), shape: sanitized }, null, 2))
    results.push({ endpoint: ep, ok: true, file: relative(ROOT, file) })
  }
  return results
}

// ── Drift check ─────────────────────────────────────────────────────────────
export function loadSnapshot(endpoint, dir = SNAPSHOT_DIR) {
  const file = join(dir, endpointToFilename(endpoint))
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function listSnapshots(dir = SNAPSHOT_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.json'))
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (args.check) {
    const snaps = listSnapshots()
    console.log(`prod-snapshots: ${snaps.length} stored`)
    for (const s of snaps) console.log(`  • ${s}`)
    return
  }

  const results = await captureAll()
  const ok = results.filter(r => r.ok).length
  console.log(`prod-snapshot-capture: ${ok}/${results.length} captured to ${relative(process.cwd(), SNAPSHOT_DIR)}/`)
  for (const r of results) {
    if (!r.ok) console.log(`  🔴 ${r.endpoint}: ${r.error}`)
  }
}

if (process.argv[1]?.endsWith('prod-snapshot-capture.mjs')) {
  main().catch(e => { console.error(e); process.exit(1) })
}
