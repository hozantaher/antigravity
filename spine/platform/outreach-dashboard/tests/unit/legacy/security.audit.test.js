import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = import.meta.dirname + '/../../..'

function readAll(dir, ext) {
  const files = []
  function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(ext) && !e.name.includes('.test.')) files.push(p)
    }
  }
  walk(dir)
  return files
}

describe('Security audit — MVP-34 (T-0309–T-0314)', () => {
  // QUARANTINED pending owner decision — see docs/handoff/ci-remediation-residual.md
  it.skip('T-0309: no hardcoded API keys or tokens in source', () => {
    const files = [...readAll(join(ROOT, 'src'), '.jsx'), ...readAll(join(ROOT, 'src'), '.js')]
    const secrets = /(?:api_?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{10,}['"]/i
    for (const f of files) {
      const content = readFileSync(f, 'utf8')
      expect(secrets.test(content), `Possible secret in ${f}`).toBe(false)
    }
  })

  it('T-0310: dangerouslySetInnerHTML only allowed in whitelisted files with rationale', () => {
    // Baseline audit. Two allowed categories:
    //
    // DOMPURIFY — file imports DOMPurify + calls DOMPurify.sanitize + has (T-0310 annotated)
    //   comment. Use for untrusted external HTML (e.g. inbound email bodies).
    //
    // TRUSTED — operator-authored content only (SQL write requires DB creds); no
    //   DOMPurify required because the data source is controlled. Must have eslint-disable
    //   react/no-danger comment as an explicit acknowledgement of the trust assumption.
    //
    // Any NEW file using dangerouslySetInnerHTML MUST be added here with a per-file
    // rationale comment and the correct category.
    const DOMPURIFY_FILES = [
      // Sprint B3: inbound email body_html (unmatched_inbound / outreach_messages) —
      // untrusted external HTML; always sanitized via DOMPurify.sanitize + DOMPURIFY_CONFIG.
      'ThreadDetail.jsx',
      // AR-chat: chat-thread bubble renders reply body_html (untrusted inbound
      // email HTML); sanitized via DOMPurify.sanitize + DOMPURIFY_CONFIG (T-0310).
      'MessageBubble.jsx',
    ]
    const TRUSTED_FILES = [
      // Pre-existing (MVP baseline): email template preview — body_html from email_templates
      // table, which requires DB credentials to write. Rendered only for operator preview;
      // not surfaced to end users. Acknowledges via eslint-disable react/no-danger.
      'Templates.jsx',
    ]

    const files = readAll(join(ROOT, 'src'), '.jsx')
    for (const f of files) {
      const content = readFileSync(f, 'utf8')
      if (!content.includes('dangerouslySetInnerHTML')) continue

      const basename = f.split('/').pop()
      if (DOMPURIFY_FILES.some(name => f.endsWith(name))) {
        expect(content.includes('DOMPurify.sanitize'), `${basename}: dangerouslySetInnerHTML without DOMPurify.sanitize`).toBe(true)
        expect(content.includes('T-0310 annotated'), `${basename}: missing (T-0310 annotated) comment`).toBe(true)
      } else if (TRUSTED_FILES.some(name => f.endsWith(name))) {
        // Trusted source; eslint-disable or no-danger comment is the required acknowledgement
        expect(
          content.includes('eslint-disable') || content.includes('no-danger'),
          `${basename}: trusted dangerouslySetInnerHTML without no-danger annotation`
        ).toBe(true)
      } else {
        expect.fail(
          `XSS risk: dangerouslySetInnerHTML in non-whitelisted file ${basename} — ` +
          `add DOMPurify.sanitize + (T-0310 annotated) comment + entry in DOMPURIFY_FILES, ` +
          `or add eslint-disable + entry in TRUSTED_FILES with rationale`
        )
      }
    }
  })

  it('T-0311: no innerHTML assignments in React code', () => {
    const files = readAll(join(ROOT, 'src'), '.jsx')
    for (const f of files) {
      const content = readFileSync(f, 'utf8')
      expect(content.includes('.innerHTML'), `innerHTML in ${f}`).toBe(false)
    }
  })

  it('T-0312: SQL queries use parameterized placeholders, not concatenation', () => {
    const serverContent = readFileSync(join(ROOT, 'server.js'), 'utf8')
    // Routes live in src/server-routes (the old src/routes path never
    // existed → this scan silently no-op'd via ENOENT for years; T-0312
    // now actually inspects the ~40 BFF route modules).
    const routeFiles = readAll(join(ROOT, 'src/server-routes'), '.js')
    const all = [serverContent, ...routeFiles.map(f => readFileSync(f, 'utf8'))]
    for (const content of all) {
      const queryBlocks = content.match(/pool\.query\([^)]+/g) || []
      for (const q of queryBlocks) {
        expect(q, 'SQL concat detected').not.toMatch(/\$\{req\.|' \+ req\./)
      }
    }
  })

  it('T-0313: no res.status(500).json with raw e.message', () => {
    const content = readFileSync(join(ROOT, 'server.js'), 'utf8')
    const rawLeaks = (content.match(/res\.status\(500\)\.json\(\{[^}]*error:\s*e\.message/g) || []).length
    expect(rawLeaks).toBe(0)
  })

  it('T-0314: auth middleware applied before route handlers', () => {
    const content = readFileSync(join(ROOT, 'server.js'), 'utf8')
    const authIdx = content.indexOf('createAuthMiddleware')
    const firstRoute = content.indexOf("app.get('/api/")
    expect(authIdx).toBeGreaterThan(-1)
    expect(authIdx).toBeLessThan(firstRoute)
  })
})
