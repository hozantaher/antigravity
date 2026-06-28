// PROOF (compliance-pii-robots-authz): a scraped record has seller PII stripped; a robots-disallowed
// path is refused; a write to a non-OUR account is refused. CANARY=1 swaps in permissive stubs (keep
// PII, allow every path, authorize anyone) — then the three refusal assertions fail, proving this
// proof catches a guardrail that waves everything through.
import { dropPII, robotsAllowed, writeAuthorized } from './compliance.mjs'
const C = process.env.CANARY
const drop = C ? (r) => r : dropPII
const robots = C ? () => true : robotsAllowed
const authz = C ? () => true : writeAuthorized

const ours = ['our-mascus', 'our-bazos']
const errs = []
const scraped = drop({ make: 'CAT', sellerName: 'Jan Novák', sellerPhone: '+420123456789' })
if (scraped.sellerName || scraped.sellerPhone) errs.push('seller PII not dropped')
if (robots('/private/inbox', ['/private']) !== false) errs.push('robots-disallowed path not refused')
if (robots('/listings', ['/private']) !== true) errs.push('allowed path wrongly refused')
if (authz('stranger-acct', ours) !== false) errs.push('unauthorized account not refused')
if (authz('our-mascus', ours) !== true) errs.push('our account wrongly refused')

if (errs.length) { console.error('COMPLY-FAIL\n  - ' + errs.join('\n  - ')); process.exit(1) }
console.log('COMPLY-OK — PII dropped, robots respected, unauthorized write refused')
process.exit(0)
