// PROOF (write-gate-audit): an UNAPPROVED write is refused (never executes); an APPROVED write
// executes AND leaves an audit entry. CANARY=1 swaps in an ungated write (forces approval) — then
// "unapproved refused" fails, proving this proof catches a write path that skips the human gate.
import { write } from './write.mjs'
const ungated = (state, op, opts) => write(state, op, { ...opts, approved: true })
const fn = process.env.CANARY ? ungated : write

const op = { kind: 'publish', ref: 'our:lst-1', fields: { title: 'CAT 320' } }
const errs = []
const refused = fn({}, op, { approved: false, account: 'our-mascus' })
if (refused.ok !== false) errs.push('unapproved write was NOT refused')
const done = fn({}, op, { approved: true, account: 'our-mascus' })
if (!done.ok) errs.push('approved write did not execute')
if (!(done.state.audit || []).length) errs.push('approved write left no audit entry')

if (errs.length) { console.error('WGATE-FAIL\n  - ' + errs.join('\n  - ')); process.exit(1) }
console.log('WGATE-OK — ungated write refused, gated write audited')
process.exit(0)
