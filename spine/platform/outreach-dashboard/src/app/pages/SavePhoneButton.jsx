import { useState } from 'react'
import { Save, Check, TriangleAlert } from 'lucide-react'

// Save a mined phone number onto the contact record (#1581 M2.2). The number is
// a regex GUESS from the reply body, so it is NEVER written silently — the
// operator clicks this and the BFF PATCHes contacts.phone (audit-logged). Shows
// a transient confirmation; idempotent on the server (re-saving the same number
// changes nothing + writes no audit row).
//
// Renders nothing without a contactId (orphan / unmatched replies have no
// contact to attach the number to).
export default function SavePhoneButton({ contactId, tel }) {
  const [state, setState] = useState('idle') // idle | saving | done | error
  if (!contactId || !tel) return null

  async function save() {
    setState('saving')
    try {
      const res = await fetch(`/api/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: tel }),
      })
      setState(res.ok ? 'done' : 'error')
    } catch {
      setState('error')
    }
  }

  if (state === 'done') {
    return <span className="app-savephone app-savephone--done" data-testid="app-savephone-done"><Check size={14} className="app-ico" aria-hidden="true" /> uloženo</span>
  }
  return (
    <button
      type="button"
      className="app-savephone"
      onClick={save}
      disabled={state === 'saving'}
      data-testid="app-savephone"
      title="Uložit telefon ke kontaktu"
    >
      {state === 'saving' ? (
        '…'
      ) : state === 'error' ? (
        <><TriangleAlert size={14} className="app-ico" aria-hidden="true" /> zkusit znovu</>
      ) : (
        <><Save size={14} className="app-ico" aria-hidden="true" /> ke kontaktu</>
      )}
    </button>
  )
}
