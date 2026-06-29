// A1 — spintax library.
// Mirrors Go ResolveSpin semantics in services/campaigns/content/spin.go so
// dry-run preview in the dashboard renders the same variants the sender does.
// Syntax: `{a|b|c}` chooses one branch. Nested groups supported: `{x {a|b}|y}`.

const VARIATION_CAP = 1_000_000

// normalizeSeed — coerce any input to a finite int32 so mulberry32 cannot
// throw on BigInt/Symbol/non-numeric. Adversarial seeds (NaN, Infinity, BigInt,
// Symbol, object) collapse to 0; numeric-coercible strings/values become int32.
function normalizeSeed(seed) {
  // Symbol cannot be Number()'d — guard explicitly.
  if (typeof seed === 'symbol') return 0
  // BigInt: take low 32 bits via mod, then cast to Number.
  if (typeof seed === 'bigint') {
    const mod = seed % 4294967296n
    return Number(mod) | 0
  }
  // Everything else: try Number(), fall back to 0 if NaN/Infinity.
  let n
  try {
    n = Number(seed)
  } catch {
    return 0
  }
  if (!Number.isFinite(n)) return 0
  return n | 0
}

// mulberry32 — small deterministic PRNG (≈Go math/rand seed parity in spirit).
// Exported for unit testing of distribution properties (U1 sprint).
// Seed coercion: normalizeSeed truncates to int32, so any JS value (incl.
// Number.MAX_SAFE_INTEGER, -2^53, NaN, Infinity, BigInt, Symbol, undefined) is
// normalized to a uint32 stream-key. Seeds that share the same low-32-bit
// pattern produce the same stream — see U1 extreme tests for documented cases.
export function mulberry32(seed) {
  let a = normalizeSeed(seed) >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function asString(input) {
  if (typeof input !== 'string') return ''
  return input
}

// findInnermostGroup returns [start, end] of the FIRST closing `}` and its
// nearest preceding `{`, or null if no balanced pair exists.
// Mirrors the Go scan: it picks the latest `{` before the first `}`.
function findInnermostGroup(text) {
  let lastOpen = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '{') lastOpen = i
    else if (c === '}' && lastOpen >= 0) return [lastOpen, i]
  }
  return null
}

// splitPipes splits on `|` at depth 0; pipes inside nested {} stay grouped.
// Empty input → [''].
function splitPipes(s) {
  const parts = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{') {
      depth++
      cur += c
    } else if (c === '}') {
      depth--
      cur += c
    } else if (c === '|' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  parts.push(cur)
  return parts
}

export function expandSpintax(input, seed) {
  let text = asString(input)
  if (!text) return ''
  const rng = seed === undefined ? Math.random : mulberry32(seed)
  // Loop: find innermost group → pick branch → splice → repeat until no more.
  while (text.indexOf('{') !== -1) {
    const range = findInnermostGroup(text)
    if (!range) break // unclosed brace → leave as-is (Go parity)
    const [start, end] = range
    const inner = text.slice(start + 1, end)
    const branches = splitPipes(inner)
    const choice = branches[Math.floor(rng() * branches.length)] ?? ''
    text = text.slice(0, start) + choice + text.slice(end + 1)
  }
  return text
}

// countVariations multiplies branch counts at each group. Returns Infinity if
// the product exceeds VARIATION_CAP (combinatorial blowup guard).
export function countVariations(input) {
  const text = asString(input)
  if (!text) return 1
  // Walk tree: parse into AST then multiply.
  const ast = parseToAst(text)
  return astCount(ast)
}

// expandAllSpintax returns up to opts.cap distinct expansions.
// Default cap = 256 (UI display safety).
// Cap semantics (documented behavior, do not change without updating U1 tests):
//   • cap omitted             → 256
//   • cap < 1 (incl. 0, neg.) → silently clamped to 1; never throws, never
//                                returns []. This keeps callers like the UI
//                                preview pane from crashing on bad config.
//   • cap = 1                 → exactly 1 deterministic variant (left-most
//                                branch at every group); identical inputs
//                                produce identical output across calls.
//   • cap = N                 → up to N distinct expansions, depth-first.
// For empty input the contract is `['']` regardless of cap.
export function expandAllSpintax(input, opts = {}) {
  const cap = Math.max(1, opts.cap ?? 256)
  const text = asString(input)
  if (!text) return ['']
  const ast = parseToAst(text)
  const out = []
  const seen = new Set()
  astExpand(ast, '', out, seen, cap)
  return out
}

// validateSpintax returns { ok, errors: [{pos, msg}] }.
export function validateSpintax(input) {
  if (typeof input !== 'string') {
    return { ok: false, errors: [{ pos: 0, msg: 'input is not a string' }] }
  }
  const errors = []
  let depth = 0
  let lastOpen = -1
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === '{') {
      depth++
      if (depth === 1) lastOpen = i
    } else if (c === '}') {
      depth--
      if (depth < 0) {
        errors.push({ pos: i, msg: 'unmatched closing brace' })
        depth = 0
      }
    }
  }
  if (depth > 0) {
    errors.push({ pos: lastOpen, msg: 'unclosed group' })
  }
  // Empty branches: scan top-level groups for `||` or `{|` or `|}`.
  const ast = parseToAst(input)
  walkAstForEmpty(ast, errors)
  const ok = errors.every(e => !/unclosed|unmatched/i.test(e.msg))
  return { ok, errors }
}

// ── AST internals ──────────────────────────────────────────────────────

// Node: { type: 'text', value: string } | { type: 'group', branches: Node[][] }
function parseToAst(text) {
  // Recursive descent: finds first balanced `{...}`, splits sibling text.
  const nodes = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open === -1) {
      if (i < text.length) nodes.push({ type: 'text', value: text.slice(i) })
      break
    }
    if (open > i) nodes.push({ type: 'text', value: text.slice(i, open) })
    const close = matchingClose(text, open)
    if (close === -1) {
      // unclosed → treat rest as text (Go parity: expand leaves them alone)
      nodes.push({ type: 'text', value: text.slice(open) })
      break
    }
    const inner = text.slice(open + 1, close)
    const branchTexts = splitPipes(inner)
    const branches = branchTexts.map(b => parseToAst(b))
    nodes.push({ type: 'group', branches })
    i = close + 1
  }
  return nodes
}

function matchingClose(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function astCount(nodes) {
  let total = 1
  for (const n of nodes) {
    if (n.type === 'text') continue
    let groupCount = 0
    for (const branch of n.branches) {
      const c = astCount(branch)
      groupCount += c
      if (groupCount >= VARIATION_CAP) return Infinity
    }
    total *= groupCount
    if (total >= VARIATION_CAP) return Infinity
  }
  return total
}

function astExpand(nodes, prefix, out, seen, cap) {
  if (out.length >= cap) return
  if (nodes.length === 0) {
    if (!seen.has(prefix)) {
      seen.add(prefix)
      out.push(prefix)
    }
    return
  }
  const [head, ...rest] = nodes
  if (head.type === 'text') {
    astExpand(rest, prefix + head.value, out, seen, cap)
    return
  }
  for (const branch of head.branches) {
    if (out.length >= cap) return
    // Expand the branch first, then continue with rest for each variant.
    const branchVariants = []
    const branchSeen = new Set()
    astExpand(branch, '', branchVariants, branchSeen, cap)
    for (const v of branchVariants) {
      if (out.length >= cap) return
      astExpand(rest, prefix + v, out, seen, cap)
    }
  }
}

function walkAstForEmpty(nodes, errors) {
  for (const n of nodes) {
    if (n.type === 'group') {
      for (const branch of n.branches) {
        if (branch.length === 0 || (branch.length === 1 && branch[0].type === 'text' && branch[0].value === '')) {
          errors.push({ pos: -1, msg: 'empty branch' })
          break
        }
      }
      for (const branch of n.branches) walkAstForEmpty(branch, errors)
    }
  }
}
