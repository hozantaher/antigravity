// PROOF (crawl-surface-catalog): the catalog lists public pages + their forms and EXCLUDES
// robots-disallowed paths. CANARY=1 swaps in a lawless crawler that ignores robots — then "disallowed
// path absent" fails, proving this proof catches a crawler that tramples robots.txt.
import { crawl } from './crawl.mjs'
const lawless = (pages) => ({ pages: pages.map((p) => p.path), forms: [], skippedByRobots: 0 })
const fn = process.env.CANARY ? lawless : crawl

const pages = [
  { path: '/listings', forms: [{ fields: ['q'] }] },
  { path: '/listing/1', forms: [] },
  { path: '/private/inbox', forms: [{ fields: ['msg'] }] },
]
const cat = fn(pages, ['/private'])
const errs = []
if (!cat.pages.includes('/listings')) errs.push('public page missing from catalog')
if (cat.pages.includes('/private/inbox')) errs.push('robots-disallowed path was catalogued')
if (!cat.forms.some((f) => f.page === '/listings')) errs.push('form not catalogued')

if (errs.length) { console.error('CRAWL-FAIL\n  - ' + errs.join('\n  - ')); process.exit(1) }
console.log('CRAWL-OK — surface catalogued, robots respected')
process.exit(0)
