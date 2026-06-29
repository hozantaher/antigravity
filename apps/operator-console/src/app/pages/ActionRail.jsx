// Odpovědi — action rail (#1586 R1 redesign). The whole výkup closes by
// PHONE, so when a reply has a mined phone number the hero action of the reading
// pane is one unmissable click-to-call button — not a pill buried among signals.
// No phone → the hero becomes Reply. The operator never hunts for "what now".
//
// reply.mined.phones[0] = { display, tel }. Pure presentational; the call is a
// tel: link (opens the Mac's phone/FaceTime), reply is a callback into the pane.
// The save-to-contact action rides next to the call (the phone is a regex guess
// the operator confirms onto the contact record).

import { Phone, CornerUpLeft } from 'lucide-react'
import SavePhoneButton from './SavePhoneButton'

export default function ActionRail({ reply, onReply }) {
  const phone = reply?.mined?.phones?.[0] || null
  return (
    <div className="app-actionrail" data-testid="app-actionrail">
      {phone ? (
        <>
          <a className="app-actionrail__primary app-actionrail__call" href={`tel:${phone.tel}`}
            data-testid="app-actionrail-call" title={`Zavolat ${phone.display}`}>
            <span className="app-actionrail__ico" aria-hidden="true"><Phone size={18} /></span>
            <span className="app-actionrail__txt">Zavolat <strong>{phone.display}</strong></span>
          </a>
          <button type="button" className="app-actionrail__secondary" onClick={onReply}
            data-testid="app-actionrail-reply">
            <CornerUpLeft size={14} className="app-ico" aria-hidden="true" /> Odpovědět
          </button>
          <SavePhoneButton contactId={reply.contact_id} tel={phone.tel} />
        </>
      ) : (
        <button type="button" className="app-actionrail__primary app-actionrail__replyhero" onClick={onReply}
          data-testid="app-actionrail-reply">
          <span className="app-actionrail__ico" aria-hidden="true"><CornerUpLeft size={18} /></span>
          <span className="app-actionrail__txt">Odpovědět</span>
        </button>
      )}
    </div>
  )
}
