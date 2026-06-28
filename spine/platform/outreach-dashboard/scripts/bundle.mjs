#!/usr/bin/env node
// Bundle size probe — gzip every dist/assets/* > write reports/bundle/SUMMARY.json.
// Does NOT build (caller decides). Read by bundle.budget.test.js.

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const DIST = 'dist/assets'
let entries
try { entries = readdirSync(DIST) } catch { console.error(`no ${DIST} — run pnpm build first`); process.exit(1) }

const out = entries
  .filter(f => /\.(js|css)$/.test(f))
  .map(f => {
    const p = join(DIST, f)
    const buf = readFileSync(p)
    const gz = gzipSync(buf, { level: 9 }).length
    // strip hash suffix for stable keys: index-XYZ.js → index.js
    const key = f.replace(/-[A-Za-z0-9_-]{6,}\./, '.')
    return { file: f, key, ext: f.split('.').pop(), raw: buf.length, gzip: gz }
  })

const totals = {
  js:  out.filter(x => x.ext === 'js' ).reduce((s, x) => s + x.gzip, 0),
  css: out.filter(x => x.ext === 'css').reduce((s, x) => s + x.gzip, 0),
}

mkdirSync('reports/bundle', { recursive: true })
writeFileSync('reports/bundle/summary.json', JSON.stringify({ chunks: out, totals }, null, 2))
console.log('bundle:', { totals, chunks: out.length })
