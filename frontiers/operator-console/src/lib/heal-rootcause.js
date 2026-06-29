// HXX1 — Root-cause attribution.
// Given a fault symptom, walks the dependency DAG upstream to find the highest-
// scoring node that could be the cause. Score = severity × recency × confidence.

const SEVERITY_WEIGHT = {
  critical: 10,
  warn:     3,
  info:     1,
}

const SIGNAL_AGE_HALF_LIFE_MS = 30 * 60 * 1000  // 30min

export function scoreNode(state) {
  if (!state || state.healthy) return 0
  if (!state.last_signal) return 1  // unhealthy but no signal — low confidence
  const sev = SEVERITY_WEIGHT[state.last_signal.severity] ?? 1
  const age = Number.isFinite(state.last_signal.age_ms) ? Math.max(0, state.last_signal.age_ms) : 0
  // Exponential decay: half-life 30min.
  const decay = Math.pow(0.5, age / SIGNAL_AGE_HALF_LIFE_MS)
  return sev * decay
}

// Collect all ancestors of a node (including itself) via deps.
function ancestors(dag, node) {
  const seen = new Set()
  const queue = [node]
  while (queue.length) {
    const n = queue.shift()
    if (seen.has(n)) continue
    seen.add(n)
    for (const d of dag.depsOf(n)) queue.push(d)
  }
  return seen
}

export function rankCandidates(dag, states, symptom) {
  if (!dag || typeof symptom !== 'string') return []
  if (!states[symptom] || states[symptom].healthy) return []
  const candidates = ancestors(dag, symptom)
  const scored = []
  for (const node of candidates) {
    const s = states[node]
    if (!s || s.healthy) continue
    scored.push({ node, score: scoreNode(s), state: s })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}

export function attributeRootCause(dag, states, symptom) {
  if (!dag) throw new Error('attributeRootCause: dag is required')
  if (!states || typeof symptom !== 'string') return null
  if (!dag.nodes.includes(symptom)) return null
  const symptomState = states[symptom]
  if (!symptomState || symptomState.healthy) return null

  const candidates = rankCandidates(dag, states, symptom)
  if (candidates.length === 0) return null

  // Within 10% of top score, prefer the most upstream node (deepest root).
  // Upstream depth = length of dependency chain from candidate to a leaf.
  // Use deps-out-degree as a quick proxy: nodes with few/no deps are roots.
  const top = candidates[0]
  const epsilon = top.score * 0.1
  const closeContenders = candidates.filter(c => top.score - c.score <= epsilon)
  // Among contenders, choose the one with fewest deps (most upstream).
  closeContenders.sort((a, b) => dag.depsOf(a.node).length - dag.depsOf(b.node).length)
  const root = closeContenders[0]

  const maxScore = SEVERITY_WEIGHT.critical
  const confidence = Math.min(1, root.score / maxScore)
  const trace = candidates.map(c => ({ node: c.node, score: Number(c.score.toFixed(2)) }))
  return {
    node: root.node,
    confidence,
    score: root.score,
    trace,
  }
}
