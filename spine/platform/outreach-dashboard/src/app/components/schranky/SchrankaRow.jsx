import { Pause, Play, Gauge, AlertCircle, KeyRound, Lock } from 'lucide-react'
import { statusMeta, healthBand, fmtNum, bounceRate, bounceRateTone } from './schrankyLib'

// SchrankaRow — one mailbox row. Identity + distinct status dot (auth_locked is
// visually flagged) + live health band + warmup/cap badge + delivery + a per-row
// pause/resume affordance. Row click opens the detail aside. Pure presentational;
// all mutations bubble up to the page (which gates them behind a confirm dialog).
export default function SchrankaRow({
  mb,
  selected,
  isOpen,
  score,
  onToggleSelect,
  onOpen,
  onTogglePause,
}) {
  const meta = statusMeta(mb.status)
  const band = healthBand(score)
  const rate = bounceRate(mb.total_sent, mb.total_bounced)
  const rateTone = bounceRateTone(rate)
  const cb = Number(mb.consecutive_bounces || 0)
  const isAuthLocked = mb.status === 'auth_locked'
  const togglable = mb.status === 'active' || mb.status === 'paused'

  return (
    <div
      className={[
        'app-sb-row',
        `app-sb-row--${meta.tone}`,
        isOpen ? 'app-sb-row--open' : '',
        isAuthLocked ? 'app-sb-row--locked' : '',
      ].filter(Boolean).join(' ')}
      role="button"
      tabIndex={0}
      aria-expanded={isOpen}
      data-testid="app-schranky-row"
      data-status={mb.status}
      onClick={() => onOpen(mb.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onOpen(mb.id) }
        else if (e.key === ' ') { e.preventDefault(); onToggleSelect(mb.id, e) }
      }}
    >
      <label className="app-sb-row__check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onToggleSelect(mb.id, e)}
          aria-label={`Vybrat ${mb.email}`}
          data-testid="app-schranky-row-check"
        />
      </label>

      <div className="app-sb-row__identity">
        <span
          className={`app-sb-dot app-sb-dot--${meta.tone}`}
          title={mb.status_reason ? `${meta.label} · ${mb.status_reason}` : meta.label}
          aria-label={meta.label}
          role="img"
          data-testid="app-schranky-status-dot"
        />
        <div className="app-sb-row__lines">
          <div className="app-sb-row__top">
            <span className="app-sb-row__email">{mb.email}</span>
            {isAuthLocked ? (
              <span className="app-sb-tag app-sb-tag--crit" data-testid="app-schranky-authlock-badge">
                <Lock size={10} strokeWidth={2} /> AUTH-LOCK
              </span>
            ) : null}
            {mb.has_valid_password === false ? (
              <span className="app-sb-tag app-sb-tag--warn" title="Schránka má placeholder heslo — SMTP přihlášení selže.">
                <KeyRound size={10} strokeWidth={2} /> HESLO
              </span>
            ) : null}
          </div>
          <div className="app-sb-row__sub">
            {mb.display_name ? <span>{mb.display_name} · </span> : null}
            <span className="app-sb-mono">{mb.host}:{mb.port}</span>
          </div>
        </div>
      </div>

      <div className={`app-sb-band app-sb-band--${band}`} data-testid="app-schranky-health-band" title={score != null ? `Zdraví ${score}/100` : 'Zdraví zatím neměřeno'}>
        {score != null ? <span className="app-sb-band__n">{score}</span> : <span className="app-sb-band__n">—</span>}
      </div>

      <div className="app-sb-warmup" data-testid="app-schranky-warmup-badge" title="Denní limit (read-only). Lifecycle fáze + cap viz detail schránky.">
        <Gauge size={12} strokeWidth={1.8} />
        <span>{mb.daily_limit != null ? `${fmtNum(mb.daily_limit)}/den` : 'dle fáze'}</span>
        {mb.warmup_day != null ? <span className="app-sb-warmup__wd">warmup&nbsp;D{mb.warmup_day}/30</span> : null}
      </div>

      <div className="app-sb-row__delivery">
        <span className="app-sb-row__sent">{fmtNum(mb.total_sent)}</span>
        {rateTone ? (
          <span className={`app-sb-tag app-sb-tag--${rateTone}`} title={`Bounce rate ${rate}%`}>{rate}%</span>
        ) : null}
        {cb > 0 ? (
          <span className={`app-sb-tag app-sb-tag--${cb >= 5 ? 'crit' : 'warn'}`}>
            <AlertCircle size={10} strokeWidth={2} /> {cb} v řadě
          </span>
        ) : null}
      </div>

      <div className="app-sb-row__actions" onClick={(e) => e.stopPropagation()}>
        {togglable ? (
          <button
            type="button"
            className="app-sb-iconbtn"
            onClick={() => onTogglePause(mb)}
            title={mb.status === 'active' ? 'Pozastavit' : 'Aktivovat'}
            aria-label={mb.status === 'active' ? 'Pozastavit' : 'Aktivovat'}
            data-testid="app-schranky-row-toggle"
          >
            {mb.status === 'active' ? <Pause size={14} strokeWidth={1.8} /> : <Play size={14} strokeWidth={1.8} />}
          </button>
        ) : null}
      </div>
    </div>
  )
}
