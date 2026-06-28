import { Link } from 'react-router-dom'
import { useResource } from '../../hooks/useResource'
import { campaignStatusMeta, bounceRate, statTiles } from '../lib/campaignMeta'
import HaltAdvisory from './HaltAdvisory'
import './app-kampane.css'

// Kampaně — read-only campaign overview on the Claude frame. One card per
// campaign: status + delivery stats (sent / bounced / failed / skipped) +
// bounce rate + sequence length. No run/pause controls — campaign send needs
// explicit operator consent (guardrail), so this surface only reads.
// docs/initiatives/2026-05-31-ux-app-claude.md (Phase 6 — completes nav).

const fmt = (n) => new Intl.NumberFormat('cs-CZ').format(n)

function Card({ c }) {
  const st = campaignStatusMeta(c.status)
  const rate = bounceRate(c.stats)
  const steps = Array.isArray(c.sequence_config) ? c.sequence_config.length : null
  return (
    <article className="app-camp" data-testid="app-campaign-card">
      {/* Whole card (except the advisory, which may hold its own controls) links
         to the editor. HaltAdvisory stays outside the anchor to avoid nested
         interactive elements. */}
      <Link to={`/kampane/${c.id}`} className="app-camp__link" data-testid="app-campaign-link"
        style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
        <div className="app-camp__head">
          <h2 className="app-camp__name">{c.name || `Kampaň ${c.id}`}</h2>
          <span className="app-tag" style={{ color: st.fg, background: st.bg }}>{st.label}</span>
        </div>
        <div className="app-camp__meta">
          {/* category_paths is a huge comma-list — show only how many targeting
             categories, never the raw dump (čitelný text bez šumu). */}
          {[
            c.category_paths ? `${String(c.category_paths).split(',').filter(Boolean).length} cílových kategorií` : null,
            steps != null ? `${steps} ${steps === 1 ? 'krok' : 'kroky'} sekvence` : null,
          ].filter(Boolean).join(' · ') || '—'}
        </div>
        <div className="app-camp__stats">
          {statTiles(c.stats).map((t) => (
            <div className="app-cstat" key={t.label}>
              <div className="app-cstat__n">{fmt(t.value)}</div>
              <div className="app-cstat__l">{t.label}</div>
            </div>
          ))}
        </div>
        {rate != null ? (
          <div className="app-camp__rate">Bounce rate <strong>{rate} %</strong> z {fmt(Number(c.stats?.sent || 0))} odeslaných</div>
        ) : null}
      </Link>
      <HaltAdvisory campaignId={c.id} />
    </article>
  )
}

export default function Kampane() {
  const list = useResource('/api/campaigns')
  const rows = Array.isArray(list.data) ? list.data : (list.data?.rows || list.data?.campaigns || [])

  return (
    <div className="app-kampane" data-testid="app-kampane">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--app-space-4)' }}>
        <Link to="/kampane/nova" data-testid="app-kampane-new"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none',
            fontSize: 'var(--app-text-sm)', fontWeight: 600, padding: '8px 14px',
            borderRadius: 'var(--app-radius-sm)', background: 'var(--app-accent)',
            color: 'var(--app-on-accent)', border: '1px solid var(--app-accent)',
          }}>
          + Nová kampaň
        </Link>
      </div>
      {(list.status === 'loading' || list.status === 'idle') && rows.length === 0 ? (
        <div className="app-kampane__grid"><div className="app-skel" /></div>
      ) : list.status === 'error' ? (
        <div className="app-empty"><div className="app-empty__title">Nepodařilo se načíst</div><div>{list.error}</div></div>
      ) : rows.length === 0 ? (
        <div className="app-empty" data-testid="app-kampane-empty">
          <div className="app-empty__title">Žádné kampaně</div>
          <div>Zatím není žádná outreach kampaň.</div>
        </div>
      ) : (
        <div className="app-kampane__grid">
          {rows.map((c) => <Card key={c.id} c={c} />)}
        </div>
      )}
    </div>
  )
}
