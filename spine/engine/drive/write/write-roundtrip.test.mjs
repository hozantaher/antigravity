// PROOF (write-operate-roundtrip): a create→edit→delete roundtrip on a staging store ends empty, and
// a repeated create is idempotent (upsert-by-our-ref — no duplicate). CANARY=1 swaps in a
// non-idempotent create (mints a fresh ref each call) — then "idempotent" fails, proving this proof
// catches a driver that double-creates on replay.
import { write } from './write.mjs'
const A = { approved: true, account: 'our-staging' }
const create = (s, ref) => write(s, { kind: 'publish', ref, fields: { title: 'T' } }, A).state
const createDup = process.env.CANARY
  ? (s, ref) => write(s, { kind: 'publish', ref: `${ref}:${Object.keys(s.listings || {}).length}`, fields: { title: 'T' } }, A).state
  : create

const errs = []
let s = create({}, 'our:lst-1')
s = createDup(s, 'our:lst-1') // idempotent: same ref → still ONE listing
if (Object.keys(s.listings).length !== 1) errs.push(`create not idempotent: ${Object.keys(s.listings).length} listings`)
s = write(s, { kind: 'edit', ref: 'our:lst-1', fields: { price: '9' } }, A).state
if (s.listings['our:lst-1']?.price !== '9') errs.push('edit did not apply')
s = write(s, { kind: 'delete', ref: 'our:lst-1' }, A).state
if (s.listings['our:lst-1']) errs.push('delete did not remove listing')

if (errs.length) { console.error('WRT-FAIL\n  - ' + errs.join('\n  - ')); process.exit(1) }
console.log('WRT-OK — create/edit/delete roundtrip idempotent')
process.exit(0)
