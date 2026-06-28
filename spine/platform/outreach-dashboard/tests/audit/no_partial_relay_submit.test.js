// Audit ratchet: raw `/v1/submit` payloads MUST include body_html + imap_host + imap_port.
//
// Rule: any fetch() to `${relay}/v1/submit` from BFF code must build a payload
// with body_html (so recipient sees HTML alternative — same render as
// engine path in machinery-outreach) and imap_host/imap_port (so relay's
// post-send sent_appender fires; gate `HasIMAP()` in
// features/outreach/relay/internal/model/model.go requires IMAPHost+IMAPPort+
// SMTPUsername+SMTPPassword).
//
// Why: incident 2026-05-12 — test send mb-to-mb dostal jen plain text (no HTML
// styling) a Sent folder zůstal prázdný, protože BFF `/api/campaigns/:id/send-test`
// neměl ani jeden z těchto fieldů. Engine path (machinery-outreach daemon)
// pulluje z DB automaticky; raw caller v BFF musí předat sám.
//
// Memory: feedback_relay_submit_full_payload (T1:anti-trace)
//
// Baseline: 0 violations.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const BFF_ROOT = resolve(__dirname, '../..')

function walkJsFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.stryker-tmp' || name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walkJsFiles(full, acc)
    } else if (/\.(m?js|cjs)$/.test(name)) {
      acc.push(full)
    }
  }
  return acc
}

// Source files to scan: server.js + src/, but exclude tests + dist.
function getScanFiles() {
  const files = [resolve(BFF_ROOT, 'server.js')]
  const srcDir = resolve(BFF_ROOT, 'src')
  walkJsFiles(srcDir, files)
  return files.filter(p => !/\/tests?\//.test(p) && !/\.test\.[jt]s$/.test(p))
}

// Two complementary patterns:
//
//   A) `fetch(\`...${relay}/v1/submit\`, { ..., body: JSON.stringify({ ... }) })` —
//      inline object literal in the fetch options. Common in handler-local code.
//
//   B) `const envelope = { ... }; ... fetch(\`...${relay}/v1/submit\`, { body: JSON.stringify(envelope) })` —
//      hoisted envelope variable. We look backward (≤2000 chars) from the fetch
//      site for the matching variable's object-literal definition.
//
// Variable-built payloads passed via deeper indirection (e.g. helper fns)
// are not statically resolvable and are covered by contract tests, not this audit.
const SUBMIT_FETCH_FINDER = /fetch\(\s*[`'"][^`'"]*\/v1\/submit[^`'"]*[`'"]\s*,/g

function findSubmitPayloads(src) {
  const hits = []
  let m
  while ((m = SUBMIT_FETCH_FINDER.exec(src)) !== null) {
    // Look ahead ≤500 chars for JSON.stringify({ ... }) (inline form, case A).
    const ahead = src.slice(m.index, m.index + 1500)
    const inline = /JSON\.stringify\(\s*\{([\s\S]*?)\}\s*\)/.exec(ahead)
    if (inline) {
      hits.push({ form: 'inline', body: inline[1], at: m.index })
      continue
    }
    // Case B: JSON.stringify(varName) — look backward for `const varName = { ... }`.
    const stringifyVar = /JSON\.stringify\(\s*([a-zA-Z_$][\w$]*)\s*\)/.exec(ahead)
    if (stringifyVar) {
      const varName = stringifyVar[1]
      const back = src.slice(Math.max(0, m.index - 2000), m.index)
      const def = new RegExp(
        `(?:const|let|var)\\s+${varName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
      ).exec(back)
      if (def) {
        hits.push({ form: 'hoisted', body: def[1], at: m.index, varName })
      } else {
        // Couldn't resolve — record as unresolvable so the audit surfaces it for
        // manual review rather than silently passing.
        hits.push({ form: 'unresolved', body: '', at: m.index, varName })
      }
    }
  }
  return hits
}

describe('audit: raw /v1/submit payloads ship body_html + imap_host/imap_port', () => {
  it('every fetch(/v1/submit) JSON.stringify body includes body_html, imap_host, imap_port', () => {
    const files = getScanFiles()
    const violations = []
    for (const path of files) {
      const src = readFileSync(path, 'utf8')
      const payloads = findSubmitPayloads(src)
      for (const p of payloads) {
        if (p.form === 'unresolved') {
          violations.push({
            file: path.replace(BFF_ROOT + '/', ''),
            missing: ['<unresolved>'],
            sample: `JSON.stringify(${p.varName}) — payload variable not statically resolvable`,
          })
          continue
        }
        const missing = []
        if (!/\bbody_html\s*:/.test(p.body)) missing.push('body_html')
        if (!/\bimap_host\s*:/.test(p.body)) missing.push('imap_host')
        if (!/\bimap_port\s*:/.test(p.body)) missing.push('imap_port')
        if (missing.length) {
          violations.push({
            file: path.replace(BFF_ROOT + '/', ''),
            missing,
            sample: p.body.replace(/\s+/g, ' ').slice(0, 120),
          })
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations
        .map(v => `  - ${v.file}: missing [${v.missing.join(', ')}]\n      sample: ${v.sample}…`)
        .join('\n')
      throw new Error(
        `Partial /v1/submit payloads detected (${violations.length}). Every BFF caller of relay /v1/submit MUST include body_html + imap_host + imap_port (memory feedback_relay_submit_full_payload):\n${msg}`,
      )
    }
    expect(violations.length).toBe(0)
  })
})
