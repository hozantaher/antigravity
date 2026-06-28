// PROOF (action-graph-replay): a test flow (login→create→edit→delete) whose actions all exist in the
// surface yields a VALID, replayable graph; a flow with a hallucinated action is INVALID. CANARY=1
// swaps in a credulous builder that blesses any flow valid — then "hallucinated flow rejected" fails,
// proving this proof catches a graph that claims actions the portal can't do.
import { buildGraph, replay } from './action-graph.mjs'
const credulous = (flow) => ({ nodes: flow.map((s) => s.action), edges: [], valid: true, hallucinated: [] })
const fn = process.env.CANARY ? credulous : buildGraph

const surface = ['login', 'create-listing', 'edit-listing', 'delete-listing']
const goodFlow = [{ action: 'login' }, { action: 'create-listing' }, { action: 'edit-listing' }, { action: 'delete-listing' }]
const badFlow = [{ action: 'login' }, { action: 'bulk-wipe-all' }] // not in surface — hallucinated

const errs = []
const g = fn(goodFlow, surface)
if (!g.valid) errs.push('valid flow rejected')
try { if (replay(g).length !== 4) errs.push('replay order wrong') } catch { errs.push('valid graph failed to replay') }
if (fn(badFlow, surface).valid !== false) errs.push('hallucinated flow NOT rejected')

if (errs.length) { console.error('GRAPH-FAIL\n  - ' + errs.join('\n  - ')); process.exit(1) }
console.log('GRAPH-OK — valid flow replays, hallucinated flow rejected')
process.exit(0)
