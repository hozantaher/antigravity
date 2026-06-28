// AJ9 (2026-05-15) — preflight check classifier extracted from PreflightGateModal.
// The modal body was unused (CampaignDetail imports only classifyChecks helper);
// helper logic preserved here as pure transform over preflight + DNS + bottleneck data.
//
// Used by CampaignDetail "Kontrola kvality e-mailů" gate to render 8 unified rows.

const LABELS = {
  proxy_assignments:     'Proxy přiřazeny všem mailboxům',
  full_check_fresh:      'Full-check čerstvý (≤ 6 h)',
  suppression_populated: 'Suppression list vyplněný',
  daily_capacity:        'Denní kapacita dostatečná',
  templates_valid:       'Šablony existují a jsou vyplněné',
  dns_audit:             'DNS audit (SPF/DMARC) v pořádku',
  anti_trace_health:     'Anti-trace relay online',
  engine_boot_status:    'Sender engine běží',
}

function classifyDnsAudit(audit) {
  if (!audit) return { ok: false, reason: 'data nedostupná' }
  if (audit.status === 'ok') return { ok: true, reason: null }
  if (audit.status === 'skip') return { ok: true, reason: 'žádné odesílací domény' }
  return { ok: false, reason: audit.status === 'warn' ? 'SPF/DMARC s varováním' : 'SPF/DMARC chyba' }
}

function classifyAntiTrace(value) {
  if (!value || value.status === 'unknown') return { ok: false, reason: 'data nedostupná' }
  if (value.status === 'up') return { ok: true, reason: null }
  if (value.status === 'not_configured') return { ok: false, reason: 'ANTI_TRACE_URL chybí' }
  return { ok: false, reason: `relay ${value.status}` }
}

function classifyEngineBoot(value) {
  if (!value || value.status === 'unknown') return { ok: false, reason: 'data nedostupná' }
  if (value.status === 'ok') return { ok: true, reason: null }
  if (value.status === 'stale') return { ok: false, reason: 'health zastaralý' }
  return { ok: false, reason: `engine ${value.status}` }
}

function buildRows({ preflight, dnsAudit, bottleneck }) {
  const rows = []
  if (Array.isArray(preflight?.checks)) {
    for (const c of preflight.checks) {
      rows.push({ key: c.name, ok: !!c.ok, label: LABELS[c.name] || c.name, reason: c.ok ? null : c.reason })
    }
  }
  const dns = classifyDnsAudit(dnsAudit)
  rows.push({ key: 'dns_audit', ok: dns.ok, label: LABELS.dns_audit, reason: dns.reason })
  const at = classifyAntiTrace(bottleneck?.antiTraceHealth)
  rows.push({ key: 'anti_trace_health', ok: at.ok, label: LABELS.anti_trace_health, reason: at.reason })
  const eb = classifyEngineBoot(bottleneck?.engineBootStatus)
  rows.push({ key: 'engine_boot_status', ok: eb.ok, label: LABELS.engine_boot_status, reason: eb.reason })
  return rows
}

export function classifyChecks(data) {
  return buildRows(data)
}

export { LABELS }
