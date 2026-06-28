// Shared presentation primitives for the Analytika surface. Pure
// presentation, no data fetching — consumers pass already-shaped data via props.
// Charts REUSE the inline-SVG approach (AnalyticsPrimitives.jsx) — no chart
// library is added — but read ONLY --app-* tokens so light/dark re-theme for free.

import { useState } from 'react'

// Czech thousands grouping — single source so every tab formats numbers alike.
export const fmt = (n) => Number(n || 0).toLocaleString('cs-CZ')

// Shared poll cadence (mirrors POLL_INTERVAL_MS). Named — no magic number.
export const POLL_MS = 60_000

// ── Card — calm panel with an optional head (title + tools) ──────────────────
export function Card({ title, icon: Icon, note, tools, testid, children }) {
  return (
    <div className="app-anl-card" data-testid={testid}>
      {(title || tools) && (
        <div className="app-anl-card__head">
          <div className="app-anl-card__title">
            {Icon ? <Icon size={15} strokeWidth={1.8} /> : null}
            <span>{title}</span>
            {note ? <span className="app-anl-card__note">{note}</span> : null}
          </div>
          {tools ? <div className="app-anl-card__tools">{tools}</div> : null}
        </div>
      )}
      {children}
    </div>
  )
}

// ── Chips — time-window / series toggle group (reuses shared .app-chip-toggle) ─
export function Chips({ value, onChange, options, label, testidPrefix }) {
  return (
    <div className="app-anl-chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="app-chip-toggle"
          aria-pressed={value === o.value}
          data-testid={testidPrefix ? `${testidPrefix}-${o.value}` : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Pill — small status badge tuned to a semantic tone ───────────────────────
export function Pill({ tone = 'neutral', title, children }) {
  return <span className={`app-anl-pill app-anl-pill--${tone}`} title={title}>{children}</span>
}

// ── Async — render the 4 useResource states around ready content ─────────────
// hasData lets the caller distinguish "loaded but empty" from "loaded with rows"
// so the calm empty state never reads as broken (never a false 0).
export function Async({ res, hasData, skeleton, empty, children }) {
  if (res.status === 'error') {
    return <div className="app-anl-msg app-anl-msg--err">{res.error || 'Nepodařilo se načíst'}</div>
  }
  if ((res.status === 'loading' || res.status === 'idle') && !hasData) {
    return skeleton ?? <div className="app-anl-skel app-anl-skel--block" />
  }
  if (hasData === false) {
    return empty ?? <div className="app-anl-msg">Žádná data</div>
  }
  return children
}

// ── BarChart — inline SVG day bars (ported from AnalyticsPrimitives) ───────
// Same geometry/interaction as v1; colors swapped to --app-* tokens. Guards empty
// data so the smoke's 0-console-error gate holds even on a slow/empty feed.
export function BarChart({ data, valueKey = 'sent', color = 'var(--app-accent)', height = 160, testid = 'app-analytika-chart' }) {
  const [hovered, setHovered] = useState(null)
  if (!data?.length) {
    return (
      <div className="app-anl-chart-empty" style={{ height }} data-testid={testid}>
        Žádná data
      </div>
    )
  }

  const values = data.map((d) => Number(d[valueKey]) || 0)
  const max = Math.max(...values, 1)
  const W = 600
  const H = height
  const PAD = { top: 12, right: 8, bottom: 28, left: 36 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom
  const barW = Math.max(2, (chartW / data.length) - 2)
  const gap = chartW / data.length
  const yLabels = [0, Math.round(max / 2), max]
  const step = Math.max(1, Math.floor(data.length / 6))

  return (
    <svg data-testid={testid} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height, display: 'block' }}>
      {yLabels.map((v, i) => {
        const y = PAD.top + chartH - (v / max) * chartH
        return (
          <g key={i}>
            <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y}
              stroke="var(--app-border-soft)" strokeWidth={1} strokeDasharray="3 3" />
            <text x={PAD.left - 4} y={y + 4} textAnchor="end" fontSize={9} fill="var(--app-text-soft)">{v}</text>
          </g>
        )
      })}

      {data.map((d, i) => {
        const v = Number(d[valueKey]) || 0
        const barH = (v / max) * chartH
        const x = PAD.left + i * gap + (gap - barW) / 2
        const y = PAD.top + chartH - barH
        const isHovered = hovered === i
        return (
          <g key={d.day || i}>
            <rect
              x={x} y={y} width={barW} height={Math.max(barH, 1)}
              fill={isHovered ? 'var(--app-accent-strong)' : color}
              opacity={isHovered ? 1 : 0.78}
              rx={2}
              style={{ cursor: 'default', transition: 'opacity .1s' }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            />
            <rect x={PAD.left + i * gap} y={PAD.top} width={gap} height={chartH}
              fill="transparent"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)} />
          </g>
        )
      })}

      {data.map((d, i) => {
        if (i % step !== 0 && i !== data.length - 1) return null
        const x = PAD.left + i * gap + gap / 2
        const label = d.day ? String(d.day).slice(5) : ''
        return (
          <text key={d.day || i} x={x} y={H - 4} textAnchor="middle" fontSize={9} fill="var(--app-text-soft)">{label}</text>
        )
      })}

      {hovered !== null && (() => {
        const d = data[hovered]
        const v = Number(d[valueKey]) || 0
        const x = PAD.left + hovered * gap + gap / 2
        const y = PAD.top + chartH - (v / max) * chartH - 8
        const tx = Math.min(Math.max(x, 40), W - 40)
        return (
          <g>
            <rect x={tx - 28} y={y - 18} width={56} height={20} rx={4}
              fill="var(--app-surface)" stroke="var(--app-border)" strokeWidth={1} />
            <text x={tx} y={y - 4} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--app-text)">
              {v}{d.day ? ` · ${String(d.day).slice(5)}` : ''}
            </text>
          </g>
        )
      })()}
    </svg>
  )
}
