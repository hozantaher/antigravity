// Pre-flight checks before POST /api/campaigns/:id/run forwards to Go.
// ─────────────────────────────────────────────────────────────────────────────
// Purpose: catch the "operator clicked Spustit too early" mistakes BEFORE
// the campaign starts dispatching. Returns a list of blocker reasons in
// Czech that the UI can render in a confirmation dialog.
//
// Three checks (each is a hard blocker):
//   M1. mailboxes  — at least one mailbox has a real (non-placeholder)
//                    password. Without this, every send hits SMTP-AUTH
//                    failure and the campaign self-pauses on the auto-hold
//                    threshold within minutes.
//   T1. template   — campaign references at least one template with a
//                    non-empty subject + body.
//   S1. segments   — campaign's category_paths cover at least one
//                    company sector with non-zero eligible contacts.
//                    Suppression UNION applied.
//
// Bypass: `?force=1` query param skips all checks. Logged via slog
// equivalent so the operator's deliberate override is auditable.
//
// Schema gaps (missing tables) are treated as blocker, not 500 — the
// operator will know something's wrong before clicking Spustit.

import { isPlaceholderPassword } from '../lib/passwordValidator.js'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Parse campaigns.category_paths — stored as a JSON-encoded array in a TEXT
 * column (NOT a pg array). `Array.isArray` on the raw value is therefore
 * always false, which silently collapses the list to [] and skips the
 * segment filter. Mirrors parseCategoryPaths in campaignSegmentExpansion.js.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseCategoryPathsText (raw) {
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.filter(p => typeof p === 'string')
  if (typeof raw !== 'string') return []
  const t = raw.trim()
  if (!t) return []
  if (t.startsWith('[')) {
    try { const a = JSON.parse(t); return Array.isArray(a) ? a.filter(p => typeof p === 'string') : [] } catch { return [] }
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    return t.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
  }
  return [t]
}

// Cache the .tmpl filename set so per-/run requests don't hit the
// filesystem on every preflight. Invalidated implicitly per-process —
// adding new templates requires a BFF restart to be picked up. That's
// fine because new .tmpl files arrive via deploy, not runtime.
//
// Scans the prod runner's source-of-truth dir + the local-dev/test dir.
// Production: services/orchestrator/Dockerfile copies
// `modules/outreach/configs/` → `/app/configs/`, and the runner reads
// `TEMPLATES_DIR=configs/templates` (default). So the prod set =
// modules/outreach/configs/templates/. The services/campaigns/configs/
// dir is the audit/test home — kept in the union so locally-added .tmpls
// are also accepted by the wizard preflight.
let tmplCache = null
export async function listTmplNames() {
  if (tmplCache) return tmplCache
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(here, '..', '..', '..', '..', '..')
  const dirs = [
    join(repoRoot, 'modules', 'outreach', 'configs', 'templates'),
    join(repoRoot, 'services', 'campaigns', 'configs', 'templates'),
  ]
  const names = new Set()
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir)
      for (const e of entries) {
        if (e.endsWith('.tmpl')) names.add(e.slice(0, -'.tmpl'.length))
      }
    } catch {
      // dir may be absent in slimmed test fixtures; non-fatal.
    }
  }
  tmplCache = names
  return tmplCache
}

/**
 * Run pre-flight checks for a campaign.
 *
 * @param {import('pg').Pool} pool
 * @param {number|string} campaignId
 * @returns {Promise<{ ok: boolean, blockers: Array<{ code: string, label: string, detail: string }>, summary: object }>}
 */
export async function runPreflight(pool, campaignId) {
  const blockers = []
  const summary = { mailboxes: 0, mailboxes_valid: 0, mailboxes_active: 0, eligible_contacts: 0 }

  // ── M1/M2: Mailboxes ───────────────────────────────────────────────
  // M1 — at least one mailbox has a real (non-placeholder) password.
  // M2 — at least one of those is in 'active' status. A mailbox can have
  //      a valid password and still be 'paused' / 'failed' (auto-hold from
  //      yesterday's bounce burst). The campaign won't send through such a
  //      mailbox until the operator explicitly Aktivuje it.
  // Mirrors services/campaigns/campaign/preflight.go which filters on
  // status='active' at the scheduler tick — this is the BFF-side mirror.
  let mailboxes = []
  try {
    const { rows } = await pool.query(
      `SELECT id, from_address AS email, password, status
       FROM outreach_mailboxes
       WHERE environment = 'production'`
    )
    mailboxes = rows
  } catch (e) {
    if (!/relation .* does not exist/i.test(e.message || '')) throw e
  }
  summary.mailboxes = mailboxes.length
  const validMailboxes = mailboxes.filter(m => !isPlaceholderPassword(m.password))
  summary.mailboxes_valid = validMailboxes.length
  const activeWithPwd = validMailboxes.filter(m => m.status === 'active')
  summary.mailboxes_active = activeWithPwd.length
  if (validMailboxes.length === 0) {
    blockers.push({
      code: 'M1_no_valid_mailbox',
      label: 'Schránka',
      detail: mailboxes.length === 0
        ? 'Žádné schránky v systému — naimportuj CSV nebo přidej v Schránkách.'
        : `Žádná z ${mailboxes.length} schránek nemá reálné heslo. Vyplň hesla v Schránkách.`,
      action_url: '/mailboxes',
    })
  } else if (activeWithPwd.length === 0) {
    blockers.push({
      code: 'M2_no_active_mailbox',
      label: 'Schránka',
      detail: `Schránky mají hesla, ale žádná není ve stavu 'active' (${validMailboxes.length} jiných stavů: paused/failed). Aktivuj v Schránkách.`,
      action_url: '/mailboxes',
    })
  }

  // ── Get campaign + category_paths ──────────────────────────────────
  let campaign = null
  try {
    const { rows } = await pool.query(
      `SELECT id, name, status, category_paths, sequence_config
       FROM campaigns WHERE id = $1`,
      [campaignId]
    )
    if (rows.length > 0) campaign = rows[0]
  } catch (e) {
    if (!/relation .* does not exist/i.test(e.message || '')) throw e
  }
  if (!campaign) {
    blockers.push({
      code: 'C1_not_found',
      label: 'Kampaň',
      detail: `Kampaň id=${campaignId} nenalezena.`,
      action_url: '/campaigns',
    })
    return { ok: false, blockers, summary, campaign: null }
  }

  // ── T1/T2: Templates ───────────────────────────────────────────────
  // T1 — sequence_config references at least one template OR DB has one
  //      ready (subject + body non-empty).
  // T2 — every template referenced in sequence_config has a corresponding
  //      .tmpl file on disk. The runner reads from disk only — a name in
  //      sequence_config that has no file produces silent zero-send when
  //      the campaign actually launches. Caught at /run time before
  //      flipping status to running.
  let templateOk = false
  let missingTmpl = []
  try {
    const sequence = Array.isArray(campaign.sequence_config)
      ? campaign.sequence_config
      : (campaign.sequence_config?.steps || [])
    const templateNames = sequence.map(s => s?.template).filter(Boolean)
    if (templateNames.length > 0) {
      templateOk = true
      const tmplFiles = await listTmplNames()
      missingTmpl = templateNames.filter(name => !tmplFiles.has(name))
    } else {
      // Fallback: any DB template with subject + body
      const { rows } = await pool.query(
        `SELECT 1 FROM email_templates
         WHERE COALESCE(trim(subject),'') <> '' AND COALESCE(trim(body),'') <> ''
         LIMIT 1`
      )
      templateOk = rows.length > 0
    }
  } catch (e) {
    if (!/relation .* does not exist/i.test(e.message || '')) throw e
  }
  if (!templateOk) {
    blockers.push({
      code: 'T1_no_template',
      label: 'Šablona',
      detail: 'Kampaň nemá žádnou šablonu s předmětem a tělem. Vytvoř šablonu nebo doplň krok 2 v Nové kampani.',
      action_url: '/templates',
    })
  } else if (missingTmpl.length > 0) {
    blockers.push({
      code: 'T2_missing_tmpl_file',
      label: 'Šablona',
      detail: `Kampaň odkazuje na šablony bez .tmpl souboru: ${missingTmpl.join(', ')}. Runner je nenajde a žádný e-mail se neodešle. Přejmenuj na: ${[...(await listTmplNames())].sort().join(', ')}.`,
      action_url: '/templates',
      missing_files: missingTmpl,
    })
  }

  // ── S1: Segments — eligible contact count for campaign's category_paths
  //
  // Bypass: if campaign_contacts is already populated (operator pre-filled
  // contacts via SQL or a prior import), the campaign can run without
  // category_paths. The runner's first-tick query joins campaign_contacts
  // directly and never re-derives the segment from sectors. Empty
  // category_paths is only a problem when the runner needs to expand the
  // segment itself.
  //
  // The pre-enqueued count is only checked when category_paths is empty
  // (the only branch where it changes the gate's verdict). This keeps the
  // existing query order — mailboxes → campaign → outreach_contacts COUNT —
  // unchanged for the common path.
  // category_paths is a JSON-encoded array in a TEXT column (not a pg array);
  // Array.isArray on the raw value was always false, so categoryPaths collapsed
  // to [] — the eligible-contacts branch below became dead code and the gate
  // falsely pushed S1_no_sectors even for campaigns that DO target sectors.
  const categoryPaths = parseCategoryPathsText(campaign.category_paths)
    .filter(p => typeof p === 'string' && p !== '')
  if (categoryPaths.length === 0) {
    let preEnqueued = 0
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM campaign_contacts
         WHERE campaign_id = $1
           AND (status IS NULL OR status IN ('pending','queued'))`,
        [campaignId]
      )
      preEnqueued = rows[0]?.n || 0
    } catch (e) {
      if (!/relation .* does not exist/i.test(e.message || '')) throw e
    }
    summary.pre_enqueued_contacts = preEnqueued
    if (preEnqueued === 0) {
      blockers.push({
        code: 'S1_no_sectors',
        label: 'Sektor',
        detail: 'Kampaň nemá vybrané sektory ani naimportované kontakty. Vyber sektor v kroku 3 Nové kampaně NEBO naimportuj kontakty do campaign_contacts.',
        action_url: `/campaigns/${campaignId}`,
      })
    } else {
      summary.eligible_contacts = preEnqueued
    }
  } else {
    let eligible = 0
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM outreach_contacts oc
         JOIN outreach_companies cm ON cm.id = oc.company_id
         WHERE cm.sector = ANY($1::text[])
           AND (oc.status IS NULL OR oc.status NOT IN ('suppressed','bounced','unsubscribed'))
           AND lower(trim(oc.email)) NOT IN (
             SELECT lower(trim(email)) FROM outreach_suppressions
             UNION
             SELECT lower(trim(email)) FROM suppression_list
           )`,
        [categoryPaths]
      )
      eligible = rows[0]?.n || 0
    } catch (e) {
      if (!/relation .* does not exist/i.test(e.message || '')) throw e
    }
    summary.eligible_contacts = eligible
    if (eligible === 0) {
      blockers.push({
        code: 'S1_zero_eligible',
        label: 'Sektor',
        detail: `Vybrané sektory (${categoryPaths.join(', ')}) nemají žádné odesilatelné kontakty. Zkontroluj suppression list nebo rozšiř výběr.`,
        action_url: `/campaigns/${campaignId}`,
      })
    }
  }

  // ── EGRESS gate (CAD-M4 / issue #559) ─────────────────────────────
  // Pulls relay /v1/egress-debug via BFF read-through cache, blocks
  // launch when egress reports a forbidden mode (direct/proxy) or
  // when egress_country_iso falls outside EXPECTED_EGRESS_COUNTRIES.
  // probe_error alone is INFO-level (relay reachable, probe failed —
  // could be temporary; do not block on it).
  try {
    const port = process.env.PORT || 18001
    const res = await fetch(`http://localhost:${port}/api/anti-trace/egress`, {
      signal: AbortSignal.timeout(20000),
    })
    if (res.ok) {
      const egress = await res.json()
      summary.egress = egress
      if (egress.ok && (egress.transport_mode === 'direct' || egress.transport_mode === 'proxy')) {
        blockers.push({
          code: 'EG1_mode_forbidden',
          label: 'Egress',
          detail: `Relay reportuje TRANSPORT_MODE=${egress.transport_mode}, což je banned (chain.go ${egress.transport_mode === 'direct' ? 'ErrDirectTransportForbidden' : 'ErrFreePoolForbidden'}). Relay měl failnout boot.`,
          action_url: '/diagnostika/anonymita',
        })
      }
      const expected = (process.env.EXPECTED_EGRESS_COUNTRIES || 'CZ')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      if (egress.ok && egress.egress_country_iso &&
          !expected.includes(egress.egress_country_iso.toUpperCase())) {
        blockers.push({
          code: 'EG2_country_drift',
          label: 'Egress',
          detail: `Egress country je ${egress.egress_country_iso}, očekáváno ${expected.join('/')}. Mullvad peer config drift na Railway. Viz docs/playbooks/launch-readiness.md decision matrix.`,
          action_url: '/diagnostika/anonymita',
        })
      }
    }
    // Non-OK fetch: degrade silently — egress endpoint may be optional
    // in dev. Prod operators see the egress card on /mailboxes.
  } catch (e) {
    if (!/(fetch failed|aborted|connect)/i.test(e.message || '')) throw e
  }

  return {
    ok: blockers.length === 0,
    blockers,
    summary,
    campaign,
  }
}
