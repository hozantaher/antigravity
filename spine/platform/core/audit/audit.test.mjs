// PROOF (audit-append-only): appending read+write actions yields a verifiable trail (each entry
// carries asset+account+result); editing a PAST entry breaks verify(). CANARY=1 swaps in a blind
// verify (always true) — then "tampered log rejected" fails, proving this proof catches a log that
// isn't really append-only.
import { append, verify } from './audit.mjs'
const ver = process.env.CANARY ? () => true : verify

let log = []
log = append(log, { asset: 'CAT0320LP1234567', account: 'our-mascus', action: 'read.fetch', result: 'ok' })
log = append(log, { asset: 'CAT0320LP1234567', account: 'our-mascus', action: 'write.publish', result: 'ok' })

const errs = []
if (!ver(log)) errs.push('clean append-only log did not verify')
if (!log.every((e) => e.asset && e.account && e.result)) errs.push('entry missing asset/account/result')
const tampered = log.map((e, i) => (i === 0 ? { ...e, result: 'HIDDEN' } : e)) // edit a past record
if (ver(tampered) !== false) errs.push('tampered log NOT rejected (not append-only)')

if (errs.length) { console.error('AUDIT-FAIL\n  - ' + errs.join('\n  - ')); process.exit(1) }
console.log('AUDIT-OK — append-only trail verifies, tamper rejected')
process.exit(0)
