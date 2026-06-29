// ─────────────────────────────────────────────────────────────────────────
//  Schema manifest diff (Phase 1 / S2 of UI-D-E-F initiative).
//
//  Pure functions only — no I/O, no Date.now(), no env reads. Given the
//  same `current` + `baseline` shapes the result is deterministic, which
//  is essential for the contract tests + the in-memory cache that backs
//  /api/__schema-check.
//
//  Inputs are the JSON shape returned by Go's /schema endpoint:
//
//    {
//      manifest_hash: 'sha256-hex',
//      tables: {
//        <table_name>: {
//          columns: [
//            { name: 'id',         type: 'integer',     nullable: false },
//            { name: 'created_at', type: 'timestamptz', nullable: true  },
//            ...
//          ]
//        },
//        ...
//      }
//    }
//
//  Why two functions:
//    - quickCheck()    — hash-only equality. Cheap, used as a fast-path
//                        before computing structural diff.
//    - diffManifests() — full structural diff: table add/remove, per-table
//                        column add/remove + type changes. Returned to the
//                        operator UI so they can see exactly what drifted.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Canonicalize a manifest so reordered column lists or table keys don't
 * register as drift. Sort columns by name, sort tables by name (object
 * key iteration order is preserved by JSON.stringify but we don't rely
 * on it — we compare structurally).
 *
 * @param {object|null|undefined} m
 * @returns {{ tables: Record<string, { columns: Array<{name:string,type:string,nullable:boolean}> }> }}
 */
function canonicalize(m) {
  const tables = (m && typeof m === 'object' && m.tables && typeof m.tables === 'object') ? m.tables : {}
  /** @type {Record<string, { columns: Array<{name:string,type:string,nullable:boolean}> }>} */
  const out = {}
  for (const name of Object.keys(tables).sort()) {
    const t = tables[name]
    const cols = Array.isArray(t?.columns) ? t.columns : []
    const safe = cols
      .filter(c => c && typeof c === 'object' && typeof c.name === 'string')
      .map(c => ({
        name: String(c.name),
        type: String(c.type ?? ''),
        nullable: Boolean(c.nullable),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    out[name] = { columns: safe }
  }
  return { tables: out }
}

/**
 * Quick hash-only check. Returns true iff both manifests carry an
 * identical non-empty manifest_hash. Anything else (missing hash on
 * either side, mismatch) → false. Caller should fall through to the
 * full diff for any "false" result.
 *
 * @param {object|null|undefined} current
 * @param {object|null|undefined} baseline
 * @returns {boolean}
 */
export function quickCheck(current, baseline) {
  const a = current && typeof current.manifest_hash === 'string' ? current.manifest_hash : ''
  const b = baseline && typeof baseline.manifest_hash === 'string' ? baseline.manifest_hash : ''
  if (!a || !b) return false
  return a === b
}

/**
 * Full structural diff. Returns:
 *
 *   {
 *     ok: boolean,                   // true iff drift is empty
 *     drift: {
 *       addedTables:    string[],    // present in current, missing in baseline
 *       removedTables:  string[],    // present in baseline, missing in current
 *       modifiedTables: Array<{
 *         name: string,
 *         addedCols:    string[],
 *         removedCols:  string[],
 *         typeChanges:  Array<{ name: string, baseline: string, current: string }>
 *       }>,
 *       hashMatch: boolean,          // manifest_hash equality (informational)
 *     }
 *   }
 *
 * Properties (verified by tests):
 *   - Symmetric: addedTables(A,B)   === removedTables(B,A) and vice versa
 *   - Symmetric: addedCols(A,B)     === removedCols(B,A) and vice versa
 *   - Type changes are symmetric with baseline/current swapped
 *   - Reordered tables/columns produce no drift (canonical compare)
 *   - Empty manifests on both sides → ok=true with empty arrays
 *
 * @param {object|null|undefined} current
 * @param {object|null|undefined} baseline
 * @returns {{
 *   ok: boolean,
 *   drift: {
 *     addedTables: string[],
 *     removedTables: string[],
 *     modifiedTables: Array<{
 *       name: string,
 *       addedCols: string[],
 *       removedCols: string[],
 *       typeChanges: Array<{ name: string, baseline: string, current: string }>,
 *     }>,
 *     hashMatch: boolean,
 *   }
 * }}
 */
export function diffManifests(current, baseline) {
  const C = canonicalize(current)
  const B = canonicalize(baseline)

  const curNames = new Set(Object.keys(C.tables))
  const baseNames = new Set(Object.keys(B.tables))

  /** @type {string[]} */
  const addedTables = []
  /** @type {string[]} */
  const removedTables = []
  for (const n of curNames) if (!baseNames.has(n)) addedTables.push(n)
  for (const n of baseNames) if (!curNames.has(n)) removedTables.push(n)
  addedTables.sort()
  removedTables.sort()

  /** @type {Array<{ name: string, addedCols: string[], removedCols: string[], typeChanges: Array<{ name: string, baseline: string, current: string }> }>} */
  const modifiedTables = []
  for (const name of [...curNames].filter(n => baseNames.has(n)).sort()) {
    const curCols = C.tables[name].columns
    const baseCols = B.tables[name].columns
    const curByName = new Map(curCols.map(c => [c.name, c]))
    const baseByName = new Map(baseCols.map(c => [c.name, c]))

    const addedCols = curCols.filter(c => !baseByName.has(c.name)).map(c => c.name).sort()
    const removedCols = baseCols.filter(c => !curByName.has(c.name)).map(c => c.name).sort()

    /** @type {Array<{ name: string, baseline: string, current: string }>} */
    const typeChanges = []
    for (const c of curCols) {
      const b = baseByName.get(c.name)
      if (!b) continue
      if (b.type !== c.type || b.nullable !== c.nullable) {
        typeChanges.push({
          name: c.name,
          baseline: `${b.type}${b.nullable ? ' NULL' : ' NOT NULL'}`,
          current: `${c.type}${c.nullable ? ' NULL' : ' NOT NULL'}`,
        })
      }
    }
    typeChanges.sort((a, b) => a.name.localeCompare(b.name))

    if (addedCols.length || removedCols.length || typeChanges.length) {
      modifiedTables.push({ name, addedCols, removedCols, typeChanges })
    }
  }

  const hashMatch = quickCheck(current, baseline)
  const ok = addedTables.length === 0 && removedTables.length === 0 && modifiedTables.length === 0

  return {
    ok,
    drift: {
      addedTables,
      removedTables,
      modifiedTables,
      hashMatch,
    },
  }
}
