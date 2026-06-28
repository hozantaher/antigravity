// Odpovědi — signature contact card (#1581 M2.1). Surfaces the structured
// contact block parsed from the reply's signature so the operator sees WHO to
// call and at which company, without scrolling the mail. The IČO links the
// reply to a known crm_clients row when one matches (the reply↔CRM edge).
//
// reply.signature = { salutation, company, ico, email, phones:[{display,tel}],
//                     crmMatch?: { id, name, crm_status } }.
// Renders nothing when there is no signature (parseSignature returned null).

import { Building2, BadgeCheck, Mail } from 'lucide-react'

export default function SignatureCard({ signature }) {
  if (!signature) return null
  const { company, ico, email, phones = [], crmMatch } = signature
  // Phones already surface in MinedSignals; only repeat one here if it adds the
  // company/identity context. Skip the card entirely if it would be empty.
  if (!company && !ico && !email && !crmMatch) return null

  return (
    <div className="app-sig" data-testid="app-signature">
      <span className="app-sig__label">Z podpisu:</span>
      {company ? <span className="app-sig__company" data-testid="app-sig-company"><Building2 size={14} className="app-ico" aria-hidden="true" /> {company}</span> : null}
      {ico ? (
        <span className="app-sig__ico" data-testid="app-sig-ico" title="IČO z podpisu">
          IČO {ico}
        </span>
      ) : null}
      {crmMatch ? (
        <span className="app-sig__crm" data-testid="app-sig-crm"
          title={`Známý klient v CRM (stav: ${crmMatch.crm_status || '—'})`}>
          <BadgeCheck size={14} className="app-ico" aria-hidden="true" /> známý klient{crmMatch.name ? `: ${crmMatch.name}` : ''}
        </span>
      ) : null}
      {email ? (
        <a className="app-sig__email" data-testid="app-sig-email" href={`mailto:${email}`}><Mail size={14} className="app-ico" aria-hidden="true" /> {email}</a>
      ) : null}
    </div>
  )
}
