// PROOF (drift-detect-no-false-success): a healthy step matches (no drift); an artificially broken
// step (selector lost the title → empty) is FLAGGED as drift, never reported as success.
// CANARY=1 swaps in a BLIND detector (always "no drift") — then the broken-flow assertion fails,
// proving this proof actually catches a driver that returns empty and claims success.
import { detectDrift } from './drift-detect.mjs'
const blind = () => ({ drift: false, reason: 'blind' })
const fn = process.env.CANARY ? blind : detectDrift

const expected = { title: 'CAT 320', price: '78000', step: 'listing-loaded' }
const healthy = { title: 'CAT 320', price: '78000', step: 'listing-loaded' }
const broken = { title: '', price: '78000', step: 'listing-loaded' } // selector lost the title

const errs = []
if (fn(expected, healthy).drift !== false) errs.push('healthy flow wrongly flagged as drift')
if (fn(expected, broken).drift !== true) errs.push('broken flow NOT detected (false-success)')

if (errs.length) { console.error('DRIFT-FAIL\n  - ' + errs.join('\n  - ')); process.exit(1) }
console.log('DRIFT-OK — broken flow detected, healthy flow clean')
process.exit(0)
