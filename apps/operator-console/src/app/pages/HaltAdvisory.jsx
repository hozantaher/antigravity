import { useState, useEffect } from 'react'

// Kampaně — halt advisory pill (#1004 [S1.3]). Reads
// GET /api/campaigns/:id/halt-advisory and shows whether the campaign's bounce
// rate is safe to keep sending. Advisory only — it never pauses anything; the
// operator decides. The safety rail visible before/while resuming.
//
// Best-effort: a fetch failure just hides the pill (the card stays usable).

const META = {
  ok:         { label: 'Bezpečné',    cls: 'ok' },
  warn_pause: { label: 'Pozastavit?', cls: 'warn' },
  hard_stop:  { label: 'Zastavit!',   cls: 'stop' },
}

export default function HaltAdvisory({ campaignId }) {
  const [adv, setAdv] = useState(null)
  useEffect(() => {
    if (!campaignId) return
    let live = true
    fetch(`/api/campaigns/${campaignId}/halt-advisory`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d) setAdv(d) })
      .catch(() => {})
    return () => { live = false }
  }, [campaignId])

  if (!adv) return null
  const m = META[adv.status] || META.ok
  return (
    <div className={`app-halt app-halt--${m.cls}`} data-testid="app-halt-advisory" title={adv.recommendation}>
      <span className="app-halt__dot" aria-hidden="true" />
      <span className="app-halt__label" data-testid="app-halt-status">{m.label}</span>
      {Number.isFinite(adv.bounce_rate_pct) && adv.thresholds?.bounce_pause_pct != null ? (
        <span className="app-halt__rate">bounce {adv.bounce_rate_pct}% / práh {adv.thresholds.bounce_pause_pct}%</span>
      ) : null}
    </div>
  )
}
