import { Link } from 'react-router-dom'
import { Building2, BadgeCheck, Banknote, Clock, Flame, MapPin } from 'lucide-react'
import { buildFacts } from '../lib/factsRow'

// Maps the stable icon KEY from buildFacts → a lucide-react component (#1586).
// Keeping the lib glyph-free means it stays a pure, render-agnostic builder and
// the visual choice lives next to the markup.
const ICONS = {
  building: Building2,
  check: BadgeCheck,
  price: Banknote,
  callback: Clock,
  urgent: Flame,
  location: MapPin,
}

// (#1586) — merged "Fakta" strip. Collapses its MinedSignals +
// SignatureCard into ONE compact row: identity facts (company / IČO / CRM)
// then business signals (price / callback / urgency / location). Renders
// nothing when there's nothing to show, so the pane stays calm. Chip data is
// computed by the pure `buildFacts` helper (unit-tested separately).

export default function FactsRow({ reply }) {
  const facts = buildFacts(reply)
  if (facts.length === 0) return null

  return (
    <div className="app-facts" data-testid="app-facts">
      {facts.map((f) => {
        const cls = `app-fact app-fact--${f.kind}${f.tone ? ` app-fact--${f.tone}` : ''}`
        const Icon = ICONS[f.icon]
        const body = (
          <>
            {Icon ? <span className="app-fact__ico" aria-hidden="true"><Icon size={14} /></span> : null}
            <span className="app-fact__txt">{f.text}</span>
          </>
        )
        return f.href ? (
          <Link key={f.key} to={f.href} className={cls} data-testid={`app-fact-${f.key}`}>{body}</Link>
        ) : (
          <span key={f.key} className={cls} data-testid={`app-fact-${f.key}`}>{body}</span>
        )
      })}
    </div>
  )
}
