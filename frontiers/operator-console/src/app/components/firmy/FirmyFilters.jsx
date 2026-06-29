import { Globe, GlobeLock, X } from 'lucide-react'

// Advanced filter panel for Firmy — segments the 426k base by mined
// firmographic attributes. Every control maps to an existing /api/companies
// query param (size · sector[] · region[] · emailConfidenceMin · hasWebsite ·
// lastContactedSince · lastContactedNever) — no new endpoint. Controlled: the
// page owns the filter object `f` + a single `patch(partial)` updater.

// ── Named constants — no magic numbers (feedback_no_magic_thresholds T0). ──
const SIZE_OPTIONS = [
  { value: '1-9', label: 'Mikro' },
  { value: '10-49', label: 'Malá' },
  { value: '50-249', label: 'Střední' },
  { value: '250+', label: 'Velká' },
]
// sector_primary distinct values — verbatim from the TopTargets curated set
// (same companies table, same column).
const SECTOR_OPTIONS = [
  { value: 'machinery', label: 'Strojírenství' },
  { value: 'construction', label: 'Stavebnictví' },
  { value: 'agriculture', label: 'Zemědělství' },
  { value: 'transport', label: 'Doprava' },
  { value: 'mining', label: 'Těžba' },
  { value: 'forestry', label: 'Lesnictví' },
  { value: 'manufacturing', label: 'Výroba' },
  { value: 'services', label: 'Služby' },
]
// region_normalized values — the 14 Czech kraje (matches TopTargets).
const REGION_OPTIONS = [
  { value: 'Hlavní město Praha', label: 'Praha' },
  { value: 'Jihočeský', label: 'Jihočeský' },
  { value: 'Jihomoravský', label: 'Jihomoravský' },
  { value: 'Karlovarský', label: 'Karlovarský' },
  { value: 'Královéhradecký', label: 'Královéhradecký' },
  { value: 'Liberecký', label: 'Liberecký' },
  { value: 'Moravskoslezský', label: 'Moravskoslezský' },
  { value: 'Olomoucký', label: 'Olomoucký' },
  { value: 'Pardubický', label: 'Pardubický' },
  { value: 'Plzeňský', label: 'Plzeňský' },
  { value: 'Středočeský', label: 'Středočeský' },
  { value: 'Ústecký', label: 'Ústecký' },
  { value: 'Vysočina', label: 'Vysočina' },
  { value: 'Zlínský', label: 'Zlínský' },
]
// email_confidence min thresholds (companies.email_confidence is 0–100).
const EMAIL_CONFIDENCE_OPTIONS = [50, 70, 90]

function toggleIn(arr, v) {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]
}

// Module-scope so it isn't recreated each render (react-hooks/static-components).
function Group({ label, children, testid }) {
  return (
    <div className="app-firmy__fgroup" data-testid={testid}>
      <span className="app-firmy__flabel">{label}</span>
      <div className="app-firmy__fchips">{children}</div>
    </div>
  )
}

export default function FirmyFilters({ f, patch }) {
  return (
    <div className="app-firmy__advanced" data-testid="app-firmy-advanced">
      <Group label="Velikost" testid="app-firmy-f-size">
        {SIZE_OPTIONS.map((o) => (
          <button type="button" key={o.value} className="app-chip-toggle"
            aria-pressed={f.size.includes(o.value)}
            data-testid={`app-firmy-size-${o.value}`}
            onClick={() => patch({ size: toggleIn(f.size, o.value) })}>{o.label}</button>
        ))}
      </Group>
      <Group label="Sektor" testid="app-firmy-f-sector">
        {SECTOR_OPTIONS.map((o) => (
          <button type="button" key={o.value} className="app-chip-toggle"
            aria-pressed={f.sectors.includes(o.value)}
            data-testid={`app-firmy-sector-${o.value}`}
            onClick={() => patch({ sectors: toggleIn(f.sectors, o.value) })}>{o.label}</button>
        ))}
      </Group>
      <Group label="Kraj" testid="app-firmy-f-region">
        {REGION_OPTIONS.map((o) => (
          <button type="button" key={o.value} className="app-chip-toggle"
            aria-pressed={f.regions.includes(o.value)}
            data-testid={`app-firmy-region-${o.value}`}
            onClick={() => patch({ regions: toggleIn(f.regions, o.value) })}>{o.label}</button>
        ))}
      </Group>
      <Group label="Jistota" testid="app-firmy-f-conf">
        {EMAIL_CONFIDENCE_OPTIONS.map((v) => (
          <button type="button" key={v} className="app-chip-toggle"
            aria-pressed={f.emailConf === v}
            data-testid={`app-firmy-conf-${v}`}
            onClick={() => patch({ emailConf: f.emailConf === v ? null : v })}>≥ {v}</button>
        ))}
      </Group>
      <Group label="Web" testid="app-firmy-f-web">
        <button type="button" className="app-chip-toggle" aria-pressed={f.web === 'with'}
          data-testid="app-firmy-web-with"
          onClick={() => patch({ web: f.web === 'with' ? null : 'with' })}>
          <Globe size={13} /> S webem
        </button>
        <button type="button" className="app-chip-toggle" aria-pressed={f.web === 'without'}
          data-testid="app-firmy-web-without"
          onClick={() => patch({ web: f.web === 'without' ? null : 'without' })}>
          <GlobeLock size={13} /> Bez webu
        </button>
      </Group>
      <Group label="Kontakt" testid="app-firmy-f-contacted">
        <button type="button" className="app-chip-toggle" aria-pressed={f.never}
          data-testid="app-firmy-never"
          onClick={() => patch({ never: !f.never, since: '' })}>Nekontaktováno</button>
        <label className="app-firmy__since">
          <span>Od</span>
          <input type="date" value={f.since} disabled={f.never}
            data-testid="app-firmy-since"
            onChange={(e) => patch({ since: e.target.value })} />
          {f.since ? (
            <button type="button" className="app-firmy__since-clear" aria-label="Zrušit datum"
              onClick={() => patch({ since: '' })}><X size={12} /></button>
          ) : null}
        </label>
      </Group>
    </div>
  )
}
