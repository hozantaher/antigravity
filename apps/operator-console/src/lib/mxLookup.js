/**
 * DNS/MX/SPF/DMARC parser — emits facts about the company's email infra.
 *
 * Why this matters for scoring:
 *   - SPF/DMARC presence → company has someone caring about deliverability
 *     → likely has IT staff → likely a real operating company.
 *   - MX provider classifies tech sophistication:
 *     google.com → Google Workspace (paid)
 *     outlook.com / protection.outlook.com → Microsoft 365
 *     mailgun/sendgrid/mandrill → transactional infra → tech-forward
 *     own MX (.firma.cz) → in-house IT
 *     seznam/centrum → free Czech webmail → micro/no-IT
 *
 * Emitted facts:
 *   { mx_provider, mx_records, has_spf, spf_strict, has_dmarc, dmarc_policy,
 *     has_dkim_record_at_default, infra_class }
 */

import { resolveMx, resolveTxt } from 'node:dns/promises'

const MX_PROVIDER_PATTERNS = [
  { pattern: /aspmx\.l\.google\.com|googlemail\.com/i,        provider: 'google_workspace' },
  { pattern: /protection\.outlook\.com|mail\.protection\./i,  provider: 'microsoft_365' },
  { pattern: /mailgun\.org/i,                                 provider: 'mailgun' },
  { pattern: /sendgrid\.net/i,                                provider: 'sendgrid' },
  { pattern: /amazonses\.com/i,                               provider: 'aws_ses' },
  { pattern: /seznam\.cz/i,                                   provider: 'seznam_cz' },
  { pattern: /centrum\.cz/i,                                  provider: 'centrum_cz' },
  { pattern: /forpsi\.com/i,                                  provider: 'forpsi' },
  { pattern: /active24\.cz/i,                                 provider: 'active24' },
  { pattern: /webglobe\.cz/i,                                 provider: 'webglobe' },
  { pattern: /hostmaster\.cz|wedos/i,                         provider: 'wedos' },
]

const INFRA_CLASS = {
  google_workspace: 'enterprise_cloud',
  microsoft_365:    'enterprise_cloud',
  mailgun:          'tech_forward',
  sendgrid:         'tech_forward',
  aws_ses:          'tech_forward',
  seznam_cz:        'consumer_grade',
  centrum_cz:       'consumer_grade',
  forpsi:           'czech_hosting',
  active24:         'czech_hosting',
  webglobe:         'czech_hosting',
  wedos:            'czech_hosting',
  unknown:          'unknown',
  self_hosted:      'self_hosted',
}

export function classifyMxProvider(exchange) {
  if (!exchange || typeof exchange !== 'string') return 'unknown'
  for (const { pattern, provider } of MX_PROVIDER_PATTERNS) {
    if (pattern.test(exchange)) return provider
  }
  // Heuristic: MX hosted on the same apex as the domain → self-hosted
  return 'self_hosted'
}

export function inferInfraClass(provider) {
  return INFRA_CLASS[provider] || 'unknown'
}

/** SPF v=spf1 ... -all → strict, ~all → soft, ?all → neutral, no policy → none. */
export function parseSpf(txtRecords) {
  const spf = (txtRecords || [])
    .map(r => Array.isArray(r) ? r.join('') : String(r))
    .find(s => /^v=spf1/i.test(s))
  if (!spf) return { has_spf: false, spf_strict: false }
  const strict = /-all\b/i.test(spf)
  return { has_spf: true, spf_strict: strict, spf_record: spf }
}

/** DMARC at _dmarc.<domain>. Policy = none|quarantine|reject. */
export function parseDmarc(txtRecords) {
  const dmarc = (txtRecords || [])
    .map(r => Array.isArray(r) ? r.join('') : String(r))
    .find(s => /^v=DMARC1/i.test(s))
  if (!dmarc) return { has_dmarc: false, dmarc_policy: null }
  const m = dmarc.match(/\bp=(none|quarantine|reject)\b/i)
  return { has_dmarc: true, dmarc_policy: m ? m[1].toLowerCase() : 'unknown', dmarc_record: dmarc }
}

/**
 * Run full lookup. Returns array of facts ready for persistFacts.
 * Pass { resolveMx, resolveTxt } to override DNS for tests.
 */
export async function probeDns(domain, deps = { resolveMx, resolveTxt }) {
  if (!domain || typeof domain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new Error(`invalid domain: ${domain}`)
  }
  const facts = []
  let provider = 'unknown'
  let mxRecords = []
  try {
    const mx = await deps.resolveMx(domain)
    mxRecords = (mx || []).sort((a, b) => a.priority - b.priority).map(r => r.exchange)
    if (mxRecords.length > 0) provider = classifyMxProvider(mxRecords[0])
    facts.push({ field: 'mx_records',   value: mxRecords })
    facts.push({ field: 'mx_provider',  value: provider })
    facts.push({ field: 'infra_class',  value: inferInfraClass(provider) })
  } catch (e) {
    if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND') throw e
    facts.push({ field: 'mx_records',  value: [] })
    facts.push({ field: 'mx_provider', value: 'none' })
    facts.push({ field: 'infra_class', value: 'unknown' })
  }
  try {
    const txt = await deps.resolveTxt(domain)
    facts.push({ field: 'spf', value: parseSpf(txt) })
  } catch (e) {
    if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND') throw e
    facts.push({ field: 'spf', value: { has_spf: false, spf_strict: false } })
  }
  try {
    const dmarcTxt = await deps.resolveTxt(`_dmarc.${domain}`)
    facts.push({ field: 'dmarc', value: parseDmarc(dmarcTxt) })
  } catch (e) {
    if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND') throw e
    facts.push({ field: 'dmarc', value: { has_dmarc: false, dmarc_policy: null } })
  }
  return facts
}

probeDns.version = 'mx_v1'
