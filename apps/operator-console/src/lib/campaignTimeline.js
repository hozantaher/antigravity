// Pure helpers for the ContactTimeline component family. Extracted from
// CampaignDetail.jsx in Y3 so the dictionaries + relativeTime formatter
// can be unit-tested without rendering React.

export const TIMELINE_EVENT_ICON = {
  sent:             '✉',
  reply_received:   '↩',
  thread_closed:    '✓',
  sequence_skipped: '⊘',
}

export const TIMELINE_EVENT_LABEL = {
  sent:             'Odesláno',
  reply_received:   'Odpověď přijata',
  thread_closed:    'Vlákno uzavřeno',
  sequence_skipped: 'Přeskočeno v sekvenci',
}

export const CLASSIFICATION_CLASS = {
  positive:    'badge-green',
  interested:  'badge-green',
  negative:    'badge-red',
  unsubscribe: 'badge-red',
  question:    'badge-blue',
  ooo:         'badge-gray',
  auto_reply:  'badge-gray',
  unknown:     'badge-gray',
}

export const CLASSIFICATION_LABEL = {
  positive:    'Pozitivní',
  interested:  'Zájem',
  negative:    'Negativní',
  unsubscribe: 'Odhlášení',
  question:    'Dotaz',
  ooo:         'Mimo kancelář',
  auto_reply:  'Auto-odpověď',
  unknown:     'Neznámé',
}

// Default timeline page size — used both by the fetch URL and to decide
// whether to render the "Zobrazeno prvních X" hint at the bottom of the
// timeline. Named constant per HARD RULE feedback_no_magic_thresholds (T0).
export const TIMELINE_DEFAULT_LIMIT = 50

// Human-readable elapsed time. Returns a compact Czech relative-time
// string (e.g. "5s", "12 min", "3 h", "2 d", "4 měs").
export function relativeTime(isoStr) {
  if (!isoStr) return '—'
  const diff = Date.now() - new Date(isoStr).getTime()
  const sec  = Math.floor(diff / 1000)
  if (sec < 60)   return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60)   return `${min} min`
  const hrs = Math.floor(min / 60)
  if (hrs < 24)   return `${hrs} h`
  const days = Math.floor(hrs / 24)
  if (days < 30)  return `${days} d`
  const months = Math.floor(days / 30)
  return `${months} měs`
}
