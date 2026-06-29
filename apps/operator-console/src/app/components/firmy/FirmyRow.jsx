import { icpMeta, scoreValue, companySubtitle, companyTitle } from '../../lib/companyMeta'

// One firma row. The row itself is a <button> (opens the detail aside), so the
// bulk-select checkbox is a SIBLING inside a wrapper — never nested inside the
// button (invalid HTML + would swallow row clicks). Mirrors the Odpovedi
// row-wrap idiom. Preserves the v1-parity data-testid `app-company-row`.
export default function FirmyRow({ c, active, selected, onOpen, onToggleSelect }) {
  const icp = icpMeta(c.icp_tier)
  const score = scoreValue(c)
  return (
    <div className={`app-frow-wrap${selected ? ' app-frow-wrap--selected' : ''}`}>
      <input
        type="checkbox"
        className="app-frow__check"
        checked={selected}
        onChange={() => onToggleSelect(c.ico)}
        aria-label={`Vybrat ${companyTitle(c)}`}
        data-testid={`app-firmy-select-${c.ico}`}
      />
      <button type="button" className="app-frow" aria-current={active ? 'true' : undefined}
        onClick={() => onOpen(c.ico)} data-testid="app-company-row">
        <div className="app-frow__top">
          <span className="app-frow__name">{companyTitle(c)}</span>
          {score != null ? <span className="app-frow__score">{score}</span> : null}
        </div>
        <div className="app-frow__sub">{companySubtitle(c) || '—'}</div>
        <div className="app-frow__tags">
          {icp ? <span className="app-tag" style={{ color: icp.fg, background: icp.bg }}>{icp.label}</span> : null}
          {c.email_status === 'valid' ? <span className="app-tag app-tag--muted">e-mail ověřen</span> : null}
        </div>
      </button>
    </div>
  )
}
