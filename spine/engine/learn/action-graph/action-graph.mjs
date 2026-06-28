// Action-graph — turn a crawled surface + a flow into a replayable operation graph: nodes are
// actions, edges are transitions. VALID iff every action exists in the surface catalog (no
// hallucinated steps the portal can't do). replay() refuses an invalid graph.
export function buildGraph(flow, surfaceActions) {
  const nodes = flow.map((step) => step.action)
  const hallucinated = nodes.filter((a) => !surfaceActions.includes(a))
  const edges = flow.slice(1).map((step, i) => ({ from: flow[i].action, to: step.action }))
  return { nodes, edges, valid: hallucinated.length === 0, hallucinated }
}

export function replay(graph) {
  if (!graph.valid) throw new Error('cannot replay invalid graph: hallucinated ' + graph.hallucinated.join(','))
  return graph.nodes // the deterministic replay order
}
