// schrankyLib.js — shared status / health mapping + formatting for the
// Schránky (Mailboxes) surface. Clean rebuild of the Mailboxes page on the
// Antique-Alchemist frame against the SAME /api/mailboxes/* BFF endpoints.
//
// Safety note: this surface fronts anti-trace egress, warmup caps, AP6 auth-lock
// quarantine and bulk pause/resume. Health-band thresholds + status tones mirror
// (src/lib/mailboxUtils.js) verbatim. Cap numbers are NEVER inlined here —
// the read-only cap display reads phase_cap/effective_cap straight off the BFF
// today-usage endpoint (single source of truth, mirrors DB migration 116).
import { Mailbox, Pause, ShieldAlert, Lock, Archive, Flame } from 'lucide-react'

// Health-band cutoffs — display mapping, identical to mailboxUtils.healthBand.
// Named (not inlined) per feedback_no_magic_thresholds (T0).
export const HEALTH_OK_MIN = 80
export const HEALTH_WARN_MIN = 50

// Status → Czech label + tone + lucide icon.
//  - auth_locked is a DISTINCT, negative-toned state (AP6 auto-quarantine):
//    3 same-op_type auth-fails / 1h → status='auth_locked' + forced 24h cooldown.
//    had no label/dot/filter for it (fell through to the raw string) —
//    makes it visually distinct, which is an intentional safety improvement.
//  - bounce_hold / retired / paused / active mirror v1.
export const STATUS_META = {
  active:      { label: 'Aktivní',        tone: 'ok',    Icon: Mailbox },
  paused:      { label: 'Pozastavená',    tone: 'warn',  Icon: Pause },
  bounce_hold: { label: 'Bounce hold',    tone: 'crit',  Icon: ShieldAlert },
  auth_locked: { label: 'Zamčená (auth)', tone: 'crit',  Icon: Lock },
  retired:     { label: 'Vyřazená',       tone: 'muted', Icon: Archive },
  warming:     { label: 'Warmup',         tone: 'muted', Icon: Flame },
}

export function statusMeta(status) {
  return STATUS_META[status] || { label: status || '—', tone: 'muted', Icon: Mailbox }
}

// Live health score (0–100 | null) → band. Mirrors mailboxUtils.healthBand.
export function healthBand(score) {
  if (score == null) return 'unknown'
  if (score >= HEALTH_OK_MIN) return 'ok'
  if (score >= HEALTH_WARN_MIN) return 'warn'
  return 'crit'
}

export const fmtNum = (n) => Number(n || 0).toLocaleString('cs-CZ')

// Bounce rate % (1 decimal) or null when nothing sent. Mirrors row math.
export function bounceRate(sent, bounced) {
  const s = Number(sent || 0)
  const b = Number(bounced || 0)
  if (s <= 0) return null
  return Number(((b / s) * 100).toFixed(1))
}

// Bounce-rate tone — thresholds: >5% err, >2% warn.
export const BOUNCE_RATE_ERR = 5
export const BOUNCE_RATE_WARN = 2
export function bounceRateTone(rate) {
  if (rate == null) return null
  if (rate > BOUNCE_RATE_ERR) return 'crit'
  if (rate > BOUNCE_RATE_WARN) return 'warn'
  return null
}
