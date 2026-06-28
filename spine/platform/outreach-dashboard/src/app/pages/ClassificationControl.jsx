import { useState } from 'react'
import { classificationMeta } from '../lib/replyMeta'

// Odpovědi — classification confidence + manual override (#1020 [S5.2]).
//
// Surfaces how confident the AUTOMATIC classifier was (reply.pre_classification:
// {intent, confidence, classifier_version}) and lets the operator correct the
// label. Override POSTs to the EXISTING PATCH /api/replies/:id/classify, which
// records a classifier_overrides row + audit (the training signal). The five
// labels match the endpoint's ALLOWED set.
//
// Only meaningful for matched replies (reply_inbox); unmatched_inbound has no
// classification column, so the parent renders this only for positive ids.

const OVERRIDE_OPTIONS = [
  { value: 'positive', label: 'Zájem' },
  { value: 'question', label: 'Dotaz' },
  { value: 'negative', label: 'Odmítnutí' },
  { value: 'unsubscribe', label: 'Odhlášení' },
  { value: 'auto_reply', label: 'Auto' },
]

// pre_classification.confidence is 0..1. Bucket it for an at-a-glance badge so
// the operator isn't reading raw decimals. Thresholds are display-only.
function confidenceBadge(pc) {
  if (!pc || typeof pc.confidence !== 'number') return null
  const pct = Math.round(pc.confidence * 100)
  const level = pct >= 70 ? 'high' : pct >= 40 ? 'mid' : 'low'
  const src = pc.classifier_version || pc.source || 'auto'
  return { pct, level, src }
}

export default function ClassificationControl({ reply, onReclassified }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  if (!reply?.id || reply.id < 0) return null  // matched (positive id) only

  const current = reply.classification || null
  const badge = confidenceBadge(reply.pre_classification)

  const override = async (value) => {
    if (value === current || busy) return
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`/api/replies/${reply.id}/classify`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification: value }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setMsg('Změněno.')
      if (typeof onReclassified === 'function') onReclassified()
    } catch (e) {
      setMsg(`Nepodařilo se: ${e.message || 'zkus znovu'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-classify" data-testid="app-classify">
      {badge ? (
        <span className={`app-classify__conf app-classify__conf--${badge.level}`} data-testid="app-classify-conf"
          title={`Automatická klasifikace: ${badge.src}`}>
          AI důvěra {badge.pct}%
        </span>
      ) : (
        <span className="app-classify__conf app-classify__conf--none" data-testid="app-classify-conf">
          Bez AI skóre
        </span>
      )}
      <span className="app-classify__label">Přeřadit:</span>
      <div className="app-classify__opts">
        {OVERRIDE_OPTIONS.map((o) => {
          const meta = classificationMeta(o.value)
          const active = o.value === current
          return (
            <button
              key={o.value}
              type="button"
              className={`app-classify__opt${active ? ' app-classify__opt--active' : ''}`}
              style={active ? { color: meta.fg, background: meta.bg, borderColor: meta.fg } : undefined}
              onClick={() => override(o.value)}
              disabled={busy || active}
              aria-pressed={active ? 'true' : 'false'}
              data-testid={`app-classify-opt-${o.value}`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
      {msg ? <span className="app-classify__msg" data-testid="app-classify-msg">{msg}</span> : null}
    </div>
  )
}
