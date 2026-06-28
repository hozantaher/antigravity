// factsRow.js — pure builder for the merged "Fakta" strip (#1586).
//
// split the reply's structured context across two boxes: SignatureCard
// (company / IČO / CRM match) and MinedSignals (price / callback / urgency /
// location). The phone moved to the ActionRail in R1. collapses what's
// LEFT of both into ONE compact strip — identity facts first, business
// signals second — so the operator reads one row instead of scanning two.
//
// Pure (no React) so it's unit-testable. Every field is derived from the real
// reply shape the BFF already returns (reply.signature + reply.mined); no
// invented columns (feedback_no_speculation).

const CZK = new Intl.NumberFormat('cs-CZ')

/**
 * @param {{
 *   signature?: { company?: string, ico?: string, crmMatch?: { name?: string, crm_status?: string }|null } | null,
 *   mined?: { prices?: Array<{ amount: number }>, callback?: boolean, urgent?: boolean, locations?: string[] } | null,
 * }} reply
 * `icon` is a stable string KEY (not a glyph) — FactsRow.jsx maps it to a
 * lucide-react icon. An empty string means "no icon" (e.g. the IČO chip).
 * Keys: 'building' | 'check' | 'price' | 'callback' | 'urgent' | 'location'.
 *
 * @returns {Array<{ key: string, icon: ''|'building'|'check'|'price'|'callback'|'urgent'|'location', text: string, kind: 'identity'|'signal', tone?: string, href?: string }>}
 */
export function buildFacts(reply) {
  const sig = reply?.signature || {}
  const mined = reply?.mined || {}
  const facts = []

  // ── Identity facts (from the signature) ──────────────────────────────
  if (sig.company) {
    facts.push({ key: 'company', icon: 'building', text: sig.company, kind: 'identity' })
  }
  if (sig.ico) {
    facts.push({ key: 'ico', icon: '', text: `IČO ${sig.ico}`, kind: 'identity', href: `/firmy?ico=${encodeURIComponent(sig.ico)}` })
  }
  if (sig.crmMatch) {
    const name = sig.crmMatch.name ? `: ${sig.crmMatch.name}` : ''
    facts.push({ key: 'crm', icon: 'check', text: `známý klient${name}`, kind: 'identity', tone: 'positive' })
  }

  // ── Business signals (mined from the body) ───────────────────────────
  const prices = Array.isArray(mined.prices) ? mined.prices : []
  for (let i = 0; i < prices.length; i++) {
    facts.push({ key: `price-${i}`, icon: 'price', text: `${CZK.format(prices[i].amount)} Kč`, kind: 'signal' })
  }
  if (mined.callback) {
    facts.push({ key: 'callback', icon: 'callback', text: 'chce zavolat', kind: 'signal' })
  }
  if (mined.urgent) {
    facts.push({ key: 'urgent', icon: 'urgent', text: 'spěchá', kind: 'signal', tone: 'urgent' })
  }
  const locations = Array.isArray(mined.locations) ? mined.locations : []
  if (locations.length > 0) {
    facts.push({ key: 'location', icon: 'location', text: locations.join(', '), kind: 'signal' })
  }

  return facts
}
