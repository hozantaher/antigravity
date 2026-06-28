// PoC seam proof: fixture listing → extract → asset record conforming to the octavius
// asset-model contract. Prints ASSET-OK (the `apply` sentinel) ONLY on full conformance.
// Octavius is dep-free, so this is a lightweight contract check (required keys + types + enums +
// no-extra-keys); production swaps it for full JSON-Schema validation (ajv).
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extract } from './extract.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function findSchema(start) {
  let dir = start
  for (let i = 0; i < 8; i++) {
    const p = resolve(dir, 'contracts/asset-model.schema.json')
    if (existsSync(p)) return p
    dir = resolve(dir, '..')
  }
  throw new Error('asset-model.schema.json not found above ' + start)
}

const schema = JSON.parse(readFileSync(findSchema(here), 'utf8'))
// Optional argv[2] = alternate fixture (relative to cwd) — used by the negativeAnchor canary to
// feed a deliberately non-conforming listing; defaults to the good fixture beside this script.
const fixtureArg = process.argv[2]
const rec = extract(fixtureArg ? resolve(process.cwd(), fixtureArg) : resolve(here, 'fixtures/mascus-listing.html'))

const errs = []
const empty = (v) => v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))
for (const k of schema.required) if (empty(rec[k])) errs.push(`missing/empty required: ${k}`)
if (!Number.isInteger(rec.year)) errs.push('year not integer')
if (!Number.isInteger(rec.operatingHours)) errs.push('operatingHours not integer')
if (!/^[A-Z]{3}$/.test(rec.currency)) errs.push(`currency '${rec.currency}' not ISO-4217`)
const lc = schema.properties.lifecycle.enum
if (lc && !lc.includes(rec.lifecycle)) errs.push(`lifecycle '${rec.lifecycle}' not in enum`)
const cc = schema.properties.condition.enum
if (rec.condition && cc && !cc.includes(rec.condition)) errs.push(`condition '${rec.condition}' not in enum`)
for (const k of Object.keys(rec)) if (!schema.properties[k]) errs.push(`unknown key not in contract: ${k}`)

if (errs.length) {
  console.error('ASSET-FAIL\n' + errs.map((e) => '  - ' + e).join('\n'))
  process.exit(1)
}
console.log('ASSET-OK — extracted record conforms to asset-model contract')
console.log(JSON.stringify(rec))
process.exit(0)
