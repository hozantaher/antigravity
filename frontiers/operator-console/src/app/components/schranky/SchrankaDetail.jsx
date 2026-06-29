import { useEffect } from 'react'
import { X, Pause, Play, Lock, Server, Network, Activity, Gauge, Megaphone } from 'lucide-react'
import { useResource } from '../../../hooks/useResource'
import { statusMeta, healthBand, fmtNum } from './schrankyLib'

// SchrankaDetail — per-mailbox detail aside (overlay drawer on tokens).
// READ-ONLY safety surface for: live health score, lifecycle phase + caps
// (warmup_d0/d3/d7/d14/production + phase_cap/effective_cap from today-usage),
// warmup progress, campaign usage and connection. State changes (pause/resume,
// clear-auth-lock) bubble to the page, which gates them behind a confirm dialog
// carrying X-Confirm-Send. NO cap-raising control is exposed here (daily_cap_
// override can only LOWER a cap — the phase-override dialog, which can raise
// it, is intentionally NOT ported).
const PHASE_LABELS = {
  warmup_d0: 'warmup_d0 (Den 0–2)',
  warmup_d3: 'warmup_d3 (Den 3–6)',
  warmup_d7: 'warmup_d7 (Den 7–13)',
  warmup_d14: 'warmup_d14 (Den 14–29)',
  production: 'production (Den 30+)',
}

export default function SchrankaDetail({ mb, score, onClose, onRequestPauseResume, onRequestClearAuthLock }) {
  const usage = useResource(`/api/mailboxes/${mb.id}/today-usage`, { pollMs: 30_000 })
  const campaigns = useResource(`/api/mailboxes/${mb.id}/campaigns`)

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const meta = statusMeta(mb.status)
  const band = healthBand(score)
  const isAuthLocked = mb.status === 'auth_locked'
  const togglable = mb.status === 'active' || mb.status === 'paused'

  const u = usage.data
  const phaseLabel = u ? (PHASE_LABELS[u.lifecycle_phase] || u.lifecycle_phase || 'unknown') : null
  const pct = u && u.effective_cap > 0 ? Math.min(100, Math.round((u.sent_today_count / u.effective_cap) * 100)) : 0
  const exhausted = u ? u.remaining_today === 0 : false

  const camps = campaigns.data?.campaigns || []
  const campTotal = campaigns.data?.total ?? 0

  return (
    <>
      <div className="app-sb-drawerbg" onClick={onClose} />
      <aside className="app-sb-drawer" role="dialog" aria-modal="true" aria-label={`Detail schránky ${mb.email}`} data-testid="app-schranky-detail">
        <header className="app-sb-drawer__head">
          <span className={`app-sb-dot app-sb-dot--${meta.tone}`} role="img" aria-label={meta.label} title={meta.label} />
          <div className="app-sb-drawer__id">
            <div className="app-sb-drawer__email" title={mb.email}>{mb.email}</div>
            <div className="app-sb-drawer__host app-sb-mono">{mb.host}:{mb.port}</div>
          </div>
          <button type="button" className="app-sb-iconbtn" onClick={onClose} aria-label="Zavřít" title="Zavřít (Esc)" data-testid="app-schranky-detail-close">
            <X size={16} strokeWidth={1.8} />
          </button>
        </header>

        <div className="app-sb-drawer__body">
          {/* Stav — live health + status */}
          <section className="app-sb-card">
            <div className="app-sb-card__title">Stav</div>
            <div className="app-sb-detrow">
              <span className="app-sb-detrow__k">Status</span>
              <span className={`app-sb-tag app-sb-tag--${meta.tone}`}>{meta.label}</span>
            </div>
            <div className="app-sb-detrow">
              <span className="app-sb-detrow__k">Zdraví</span>
              <span className={`app-sb-band app-sb-band--${band} app-sb-band--inline`}>{score != null ? `${score}/100` : 'neměřeno'}</span>
            </div>
            {mb.status_reason ? (
              <div className="app-sb-detrow"><span className="app-sb-detrow__k">Důvod</span><code className="app-sb-mono">{mb.status_reason}</code></div>
            ) : null}
          </section>

          {/* Auth-lock — distinct + clear action (24h cooldown enforced by BFF) */}
          {isAuthLocked ? (
            <section className="app-sb-card app-sb-card--crit" data-testid="app-schranky-detail-authlock">
              <div className="app-sb-card__title"><Lock size={13} strokeWidth={1.8} /> Auth-lock (AP6)</div>
              <p className="app-sb-card__note">
                Automaticky uzamčena po opakovaných selháních přihlášení. Odemčení
                je možné až 24 h od uzamčení; poté přejde do <code>paused</code>.
              </p>
              <button type="button" className="app-sb-btn app-sb-btn--danger app-sb-btn--full"
                onClick={() => onRequestClearAuthLock(mb)} data-testid="app-schranky-detail-clear-authlock">
                <Lock size={14} strokeWidth={1.8} /> Zrušit auth-lock…
              </button>
            </section>
          ) : null}

          {/* Denní limit & lifecycle fáze — READ ONLY */}
          <section className={`app-sb-card${exhausted ? ' app-sb-card--crit' : ''}`} data-testid="app-schranky-detail-cap">
            <div className="app-sb-card__title"><Gauge size={13} strokeWidth={1.8} /> Denní limit & fáze</div>
            {usage.status === 'error' ? (
              <div className="app-sb-card__note">Limit se nepodařilo načíst: {usage.error}</div>
            ) : !u ? (
              <div className="app-sb-skel app-sb-skel--line" />
            ) : (
              <>
                <div className="app-sb-detrow">
                  <span className="app-sb-detrow__k">Fáze</span>
                  <span data-testid="app-schranky-detail-phase">{phaseLabel}</span>
                </div>
                <div className="app-sb-capbar" role="progressbar" aria-valuemin={0} aria-valuemax={u.effective_cap} aria-valuenow={u.sent_today_count} aria-label="Využití denního limitu">
                  <div className={`app-sb-capbar__fill${exhausted ? ' app-sb-capbar__fill--crit' : ''}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="app-sb-detrow">
                  <span className="app-sb-detrow__k">Dnes</span>
                  <span>{u.sent_today_count} / {u.effective_cap} odesláno{exhausted ? ' · vyčerpáno' : ` · ${u.remaining_today} zbývá`}</span>
                </div>
                <div className="app-sb-detrow">
                  <span className="app-sb-detrow__k">Cap</span>
                  <span>
                    fáze {u.phase_cap}/den · override {u.daily_cap_override == null ? '—' : u.daily_cap_override} · efektivní <strong>{u.effective_cap}/den</strong>
                  </span>
                </div>
                <div className="app-sb-card__note">
                  Zdroj: {u.cap_source === 'daily_cap_override' ? 'operator override' : 'lifecycle fáze'}.
                  Override smí cap pouze <strong>snižovat</strong>, nikdy zvyšovat.
                </div>
              </>
            )}
          </section>

          {/* Warmup */}
          <section className="app-sb-card">
            <div className="app-sb-card__title"><Activity size={13} strokeWidth={1.8} /> Warmup</div>
            {mb.warmup_day != null ? (
              <>
                <div className="app-sb-detrow">
                  <span className="app-sb-detrow__k">Den</span>
                  <span>{mb.warmup_day}/30 · {mb.warmup_paused ? 'pozastaven' : 'aktivní'}</span>
                </div>
                <div className="app-sb-capbar">
                  <div className="app-sb-capbar__fill" style={{ width: `${Math.min(100, Math.round((mb.warmup_day / 30) * 100))}%` }} />
                </div>
                {mb.warmup_pause_reason ? <div className="app-sb-card__note">Důvod: {mb.warmup_pause_reason}</div> : null}
              </>
            ) : (
              <div className="app-sb-card__note">Warmup není nastaven (řízeno lifecycle fází).</div>
            )}
          </section>

          {/* Použití v kampaních */}
          <section className="app-sb-card">
            <div className="app-sb-card__title"><Megaphone size={13} strokeWidth={1.8} /> Použití</div>
            {campaigns.status === 'error' ? (
              <div className="app-sb-card__note">Nepodařilo se načíst.</div>
            ) : campaigns.status !== 'ok' ? (
              <div className="app-sb-skel app-sb-skel--line" />
            ) : campTotal === 0 ? (
              <div className="app-sb-card__note">Schránka nebyla použita v žádné kampani.</div>
            ) : (
              <ul className="app-sb-camplist">
                {camps.slice(0, 5).map((c) => (
                  <li key={c.id} className="app-sb-camplist__item">
                    <span className="app-sb-camplist__name" title={c.name}>{c.name}</span>
                    <span className="app-sb-camplist__meta">{c.sent_count != null ? `${fmtNum(c.sent_count)} odesláno` : ''}{c.status ? ` · ${c.status}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Připojení */}
          <section className="app-sb-card">
            <div className="app-sb-card__title"><Server size={13} strokeWidth={1.8} /> Připojení</div>
            <div className="app-sb-detrow"><span className="app-sb-detrow__k">SMTP</span><span className="app-sb-mono">{mb.host}:{mb.port}</span></div>
            <div className="app-sb-detrow">
              <span className="app-sb-detrow__k"><Network size={11} strokeWidth={1.8} /> IMAP</span>
              <span className="app-sb-mono">{mb.imap_host ? `${mb.imap_host}:${mb.imap_port}` : '—'}</span>
            </div>
          </section>

          {/* Akce */}
          {togglable ? (
            <section className="app-sb-card">
              <div className="app-sb-card__title">Akce</div>
              <button type="button" className="app-sb-btn app-sb-btn--full"
                onClick={() => onRequestPauseResume(mb)} data-testid="app-schranky-detail-toggle">
                {mb.status === 'active'
                  ? <><Pause size={14} strokeWidth={1.8} /> Pozastavit schránku</>
                  : <><Play size={14} strokeWidth={1.8} /> Aktivovat schránku</>}
              </button>
            </section>
          ) : null}
        </div>
      </aside>
    </>
  )
}
