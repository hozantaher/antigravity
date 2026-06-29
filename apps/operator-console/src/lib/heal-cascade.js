// HX1 — Cascading dependency recovery (DAG order).
// Pure functions for modeling dependency chains in the heal pipeline.
//
// Production chain: anti_trace ← relay ← sender ← bff_cron ← reporter
// "A depends on B" means A cannot heal until B is healthy.

class DAG {
  constructor(edges) {
    this._edges = []
    this._nodes = new Set()
    this._depsByNode = new Map()  // node → Set<dep>
    this._reverse   = new Map()   // node → Set<dependent>
    for (const [from, to] of edges) {
      if (from === to) throw new Error(`DAG: self-loop on ${from}`)
      this._nodes.add(from)
      this._nodes.add(to)
      this._edges.push([from, to])
      if (!this._depsByNode.has(from)) this._depsByNode.set(from, new Set())
      if (!this._reverse.has(to))      this._reverse.set(to, new Set())
      this._depsByNode.get(from).add(to)
      this._reverse.get(to).add(from)
    }
    this._detectCycles()
  }

  get nodes() { return [...this._nodes] }
  depsOf(node) { return [...(this._depsByNode.get(node) || [])] }
  dependentsOf(node) { return [...(this._reverse.get(node) || [])] }

  _detectCycles() {
    // DFS with three-color marking: 0=unvisited, 1=in-stack, 2=done
    const color = new Map()
    for (const n of this._nodes) color.set(n, 0)
    const visit = (node, path) => {
      color.set(node, 1)
      for (const dep of this.depsOf(node)) {
        if (color.get(dep) === 1) {
          throw new Error(`DAG: cyclic at ${path.concat(dep).join('→')}`)
        }
        if (color.get(dep) === 0) visit(dep, path.concat(dep))
      }
      color.set(node, 2)
    }
    for (const n of this._nodes) {
      if (color.get(n) === 0) visit(n, [n])
    }
  }
}

export function buildDependencyDAG(edges) {
  return new DAG(edges)
}

export function topologicalHealOrder(dag) {
  // in-degree of N = number of prerequisites N must wait for = |depsOf(N)|.
  // Start with nodes that have no prerequisites (roots). When a root is
  // processed, decrement in-degree of every node that depends on it.
  const inDegree = new Map()
  for (const n of dag.nodes) inDegree.set(n, dag.depsOf(n).length)
  const queue = []
  for (const [n, d] of inDegree) {
    if (d === 0) queue.push(n)
  }
  const out = []
  while (queue.length > 0) {
    const n = queue.shift()
    out.push(n)
    for (const dependent of dag.dependentsOf(n)) {
      inDegree.set(dependent, inDegree.get(dependent) - 1)
      if (inDegree.get(dependent) === 0) queue.push(dependent)
    }
  }
  return out
}

// cascadeFailure: starting from a failed root, marks all transitive dependents.
export function cascadeFailure(dag, rootFailed) {
  const unhealthy = new Set([rootFailed])
  const queue = [rootFailed]
  while (queue.length > 0) {
    const n = queue.shift()
    for (const dep of dag.dependentsOf(n)) {
      if (!unhealthy.has(dep)) {
        unhealthy.add(dep)
        queue.push(dep)
      }
    }
  }
  return { unhealthy: [...unhealthy] }
}

// cascadeRecovery: returns the heal order for unhealthy nodes (topological).
export function cascadeRecovery(dag, unhealthy) {
  const fullOrder = topologicalHealOrder(dag)
  return fullOrder.filter(n => unhealthy.includes(n))
}

// isHealReadyFor: a node is ready to heal iff all its deps are healthy.
export function isHealReadyFor(node, dag, unhealthy) {
  const deps = dag.depsOf(node)
  return deps.every(d => !unhealthy.includes(d))
}
