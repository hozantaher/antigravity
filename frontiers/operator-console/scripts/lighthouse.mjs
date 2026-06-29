#!/usr/bin/env node
// Lighthouse perf probe — run against built dashboard. Uses programmatic
// API (lighthouse package) rather than CLI for stable output. Writes
// per-route summary to reports/lighthouse/summary.json.
//
// Run: pnpm preview & node scripts/lighthouse.mjs

import lighthouse from 'lighthouse'
import * as chromeLauncher from 'chrome-launcher'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.LH_BASE || 'http://localhost:5175'
const ROUTES = ['/', '/companies', '/campaigns', '/mailboxes', '/templates']

const chromePath = process.env.CHROME_PATH ||
  '/Users/messingtomas/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const chrome = await chromeLauncher.launch({ chromePath, chromeFlags: ['--headless=new', '--no-sandbox'] })
const opts = {
  port: chrome.port,
  output: 'json',
  logLevel: 'error',
  onlyCategories: ['performance'],
}

const results = []
for (const path of ROUTES) {
  process.stderr.write(`→ ${path} ... `)
  const r = await lighthouse(BASE + path, opts)
  const lhr = r.lhr
  const audits = lhr.audits
  results.push({
    path,
    perf: Math.round((lhr.categories.performance.score || 0) * 100),
    lcp: audits['largest-contentful-paint']?.numericValue,
    cls: audits['cumulative-layout-shift']?.numericValue,
    tbt: audits['total-blocking-time']?.numericValue,
    fcp: audits['first-contentful-paint']?.numericValue,
    si:  audits['speed-index']?.numericValue,
  })
  process.stderr.write(`perf=${Math.round((lhr.categories.performance.score || 0) * 100)}\n`)
}
await chrome.kill()

mkdirSync('reports/lighthouse', { recursive: true })
writeFileSync('reports/lighthouse/summary.json', JSON.stringify({ base: BASE, routes: results }, null, 2))
console.log('lighthouse summary →', 'reports/lighthouse/summary.json')
