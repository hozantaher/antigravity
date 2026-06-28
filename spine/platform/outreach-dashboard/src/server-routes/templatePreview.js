// Template preview — renders campaign templates with placeholder vars so
// the operator can sanity-check what recipients will see before launching.
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors the substitution rules in services/campaigns/content/template.go
// (substituteVars). Both spelling forms are supported: {{firma}} + {{.Firma}}.
//
// Includes the GDPR footer verbatim (template files in
// services/campaigns/configs/templates/) so the operator sees the full
// recipient view, not just the headline body.
//
// Sample vars are clearly labelled UKÁZKA so no operator mistakes the
// preview for a real send. Refuses to send any actual mail — read-only.

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SAMPLE_VARS = {
  Firma: 'UKÁZKA: ACME Stavebniny s.r.o.',
  Jmeno: 'Jan',
  Prijmeni: 'Novák',
  Region: 'Středočeský kraj',
  ICO: '12345678',
  Podpis: 'Goran Nowak',
  UnsubURL: 'https://garaaage.cz/unsubscribe?c=PREVIEW&id=PREVIEW&t=preview12345678',
}

// Locate the templates dir relative to this module. The runner reads the
// same directory in production so we stay in sync — no fabricated content.
function templatesDir() {
  const here = dirname(fileURLToPath(import.meta.url))
  // .../features/platform/outreach-dashboard/src/server-routes → repo root → modules/outreach/configs/templates
  return join(here, '..', '..', '..', '..', '..', 'modules', 'outreach', 'configs', 'templates')
}

function substituteVars(text, vars) {
  const replacements = {
    '{{firma}}':    vars.Firma,
    '{{jmeno}}':    vars.Jmeno,
    '{{prijmeni}}': vars.Prijmeni,
    '{{region}}':   vars.Region,
    '{{ico}}':      vars.ICO,
    '{{podpis}}':   vars.Podpis,
    '{{unsuburl}}': vars.UnsubURL,
    '{{.Firma}}':    vars.Firma,
    '{{.Jmeno}}':    vars.Jmeno,
    '{{.Prijmeni}}': vars.Prijmeni,
    '{{.Region}}':   vars.Region,
    '{{.ICO}}':      vars.ICO,
    '{{.Podpis}}':   vars.Podpis,
    '{{.UnsubURL}}': vars.UnsubURL,
  }
  let out = text
  for (const [key, val] of Object.entries(replacements)) {
    out = out.split(key).join(val)
  }
  return out
}

// Pull subject candidates from the {{/* subject: ... */}} comments.
// Returns the first one (deterministic for preview).
function extractSubject(raw) {
  const m = raw.match(/\{\{\/\*\s*subject:\s*([^*]+?)\s*\*\/\}\}/)
  return m ? m[1].trim() : '(no subject)'
}

// Strip Go template comments + humanize directive from body.
function stripDirectives(raw) {
  return raw.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, '').replace(/^\s*\n+/, '')
}

/**
 * Mount the template-preview route on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{ capture500: Function, safeError: Function }} deps
 */
export function mountTemplatePreviewRoute(app, { capture500, safeError }) {
  app.get('/api/templates/preview', async (req, res) => {
    try {
      const dir = templatesDir()
      let files = []
      try {
        files = (await readdir(dir)).filter(f => f.endsWith('.tmpl')).sort()
      } catch (e) {
        if (e.code === 'ENOENT') {
          return res.json({ ok: false, error: 'templates dir not found', dir, templates: [] })
        }
        throw e
      }
      const requested = String(req.query.template || '').trim()
      const target = requested && files.includes(`${requested}.tmpl`)
        ? `${requested}.tmpl`
        : files[0]
      if (!target) {
        return res.json({ ok: false, error: 'no templates found', templates: [] })
      }
      const raw = await readFile(join(dir, target), 'utf8')
      const subjectRaw = extractSubject(raw)
      const bodyRaw = stripDirectives(raw)
      const subject = substituteVars(subjectRaw, SAMPLE_VARS)
      const body = substituteVars(bodyRaw, SAMPLE_VARS)
      res.json({
        ok: true,
        template: target.replace(/\.tmpl$/, ''),
        templates: files.map(f => f.replace(/\.tmpl$/, '')),
        subject,
        body,
        sample_vars: SAMPLE_VARS,
        note: 'Toto je UKÁZKA renderu se zástupnými proměnnými. Skutečný recipient uvidí substituované hodnoty z DB.',
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}

// Note: substituteVars, SAMPLE_VARS, extractSubject, stripDirectives internal helpers
