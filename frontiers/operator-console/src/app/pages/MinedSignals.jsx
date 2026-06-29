// Odpovědi — mined signals strip (#1578 M1.1, #1586 R1). Surfaces the
// structured signals pulled from the reply body so the operator acts without
// scanning the email: price (negotiation anchor), callback/urgency intent,
// location (logistics). The PHONE moved to the ActionRail (#1586 R1) — it is the
// hero call-to-action, not a chip among signals — so it is no longer rendered here.
//
// reply.mined = { phones, prices, callback, urgent, locations }.
// Renders nothing when there's nothing left to show (no empty chrome).

import { Banknote, Clock, Flame, MapPin } from 'lucide-react'

export default function MinedSignals({ mined }) {
  const prices = mined?.prices || []
  const callback = !!mined?.callback
  const urgent = !!mined?.urgent
  const locations = mined?.locations || []
  if (prices.length === 0 && !callback && !urgent && locations.length === 0) return null

  const fmtCzk = (n) => new Intl.NumberFormat('cs-CZ').format(n) + ' Kč'

  return (
    <div className="app-mined" data-testid="app-mined">
      <span className="app-mined__label">Vytěženo z e-mailu:</span>
      {prices.map((pr, i) => (
        <span key={`${pr.amount}-${i}`} className="app-mined__price" data-testid="app-mined-price">
          <Banknote size={14} className="app-ico" aria-hidden="true" /> {fmtCzk(pr.amount)}
        </span>
      ))}
      {callback ? <span className="app-mined__flag app-mined__flag--call" data-testid="app-mined-callback"><Clock size={14} className="app-ico" aria-hidden="true" /> Chce zavolat</span> : null}
      {urgent ? <span className="app-mined__flag app-mined__flag--urgent" data-testid="app-mined-urgent"><Flame size={14} className="app-ico" aria-hidden="true" /> Spěchá</span> : null}
      {locations.length > 0 ? (
        <span className="app-mined__loc" data-testid="app-mined-location"><MapPin size={14} className="app-ico" aria-hidden="true" /> {locations.join(', ')}</span>
      ) : null}
    </div>
  )
}
