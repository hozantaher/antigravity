// Public privacy notice — referenced from email footers (campaign templates).
// ─────────────────────────────────────────────────────────────────────────────
// Renders docs/legal/privacy-notice.md as basic HTML. No auth, no tracking.
// CRITICAL: this route MUST stay public — recipients of B2B outreach must be
// able to read the privacy policy without any login or paywall. If this ever
// regresses to 401/403, every campaign email footer becomes GDPR-violating.
//
// T3.2 (2026-05-01): extracted verbatim from server.js per ADR-008. Behavior
// is byte-equivalent to the inline declaration: same markdown→HTML transform,
// same response headers, same fallback text on read failure. The audit test
// in `tests/audit/gdpr-cascade-shape.test.js` and the contract test in
// `tests/contract/bff-privacy-public-route.contract.test.ts` continue to
// verify the contract; the multi-file audit pattern (PR #443) means no
// audit/test changes are required for the move itself.

/**
 * Mount the public privacy notice route on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 * }} deps
 */
export function mountPrivacyRoutes(app, { pool } = {}) {
  app.get('/privacy', async (req, res) => {
    try {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const repoRoot = path.resolve(import.meta.dirname || __dirname, '..', '..', '..', '..')
      const md = await fs.readFile(path.join(repoRoot, 'docs/legal/privacy-notice.md'), 'utf8')

      // Fetch controller_name from operator_settings; fall back to hardcoded value
      let controllerName = 'Garaaage s.r.o.'
      if (pool) {
        try {
          const { rows } = await pool.query(
            `SELECT value FROM operator_settings WHERE key='controller_name' LIMIT 1`
          )
          if (rows.length > 0) {
            controllerName = rows[0].value
          }
        } catch {
          // Silently fall back to hardcoded value on DB error
        }
      }

      // Minimal markdown → HTML (headings + paragraphs + bold + lists). No deps.
      const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const html = escape(md)
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/^---$/gm, '<hr>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.+<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
        .split(/\n\n+/).map((p) => p.match(/^<(h\d|ul|hr)/) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.send(`<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zásady zpracování osobních údajů — ${controllerName}</title>
<style>
body{max-width:720px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif;color:#222}
h1,h2,h3{line-height:1.3;margin-top:2rem}
hr{border:0;border-top:1px solid #ddd;margin:2rem 0}
ul{padding-left:1.5rem}
strong{color:#000}
</style>
</head>
<body>
${html}
</body>
</html>`)
    } catch (e) {
      res.status(500).type('text/plain').send('Privacy notice temporarily unavailable. Email privacy@garaaage.cz for the GDPR-compliant text.')
    }
  })
}
