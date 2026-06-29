import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Layers, Users, RefreshCw, Save, AlertTriangle, Mail, MapPin, CopyCheck,
} from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useToast } from '../../components/Toast'
import Empty from '../components/Empty'
import './app-segment-builder.css'

// Nový segment — live, PII-safe count builder on the Antique Alchemist frame.
// Clean rebuild of the SegmentBuilder (src/pages/SegmentBuilder.jsx) against
// the SAME BFF endpoints:
//   GET  /api/categories          — category / NACE-sector tree (4-state fetch)
//   GET  /api/segments/preview    — live count (counts only, never PII)
//   POST /api/segments            — persist {name, description, query}
// Reached from the Segmenty list (route /segmenty/novy — not a nav item).
// docs/initiatives — dashboard FE unification.

// ── Named thresholds (no magic numbers — feedback_no_magic_thresholds T0) ──────
const LIVE_COUNT_DEBOUNCE_MS = 500   // mirrors v1's live-count debounce
const DOMAIN_CONCENTRATION_WARN = 5  // max-per-domain above this = fingerprint risk
const TOP_DOMAINS_SHOWN = 10
const MIN_SEGMENT_NAME_LEN = 2

// CZ kraje — 14 entries per ISO 3166-2:CZ (verbatim from v1).
const CZ_REGIONS = [
  'Praha', 'Středočeský', 'Jihočeský', 'Plzeňský', 'Karlovarský', 'Ústecký',
  'Liberecký', 'Královéhradecký', 'Pardubický', 'Vysočina', 'Jihomoravský',
  'Olomoucký', 'Zlínský', 'Moravskoslezský',
]

const EMAIL_STATUS_OPTIONS = [
  { value: 'valid', label: 'Platný' },
  { value: 'invalid', label: 'Neplatný' },
  { value: 'risky', label: 'Rizikový' },
  { value: 'null', label: 'Neověřený' },
]

// Breakdown tiles — key matches the preview response shape.
const EMAIL_STATUS_TILES = [
  { key: 'valid', label: 'Platný', cls: 'app-sb-stat--ok' },
  { key: 'invalid', label: 'Neplatný', cls: 'app-sb-stat--err' },
  { key: 'risky', label: 'Rizikový', cls: 'app-sb-stat--warn' },
  { key: 'null', label: 'Neověřený', cls: 'app-sb-stat--muted' },
]

const fmt = (n) => new Intl.NumberFormat('cs-CZ').format(Number(n) || 0)

// Identifier sent to the preview `sectors` param + stored in the saved query.
// Mirrors v1's `cat.code ?? cat.id ?? label` fallback chain against the live
// /api/categories shape ({id, path, slug, name, company_count}).
const nodeValue = (cat) => String(cat.slug ?? cat.path ?? cat.id ?? cat.name ?? '')
const nodeLabel = (cat) => cat.name ?? cat.path ?? cat.slug ?? nodeValue(cat)

export default function SegmentBuilder() {
  const navigate = useNavigate()
  const toast = useToast()

  // ── Category tree (4-state via useResource) ─────────────────────────────────
  const tree = useResource('/api/categories', {
    initialData: [],
    parse: (r) => (Array.isArray(r) ? r : (r?.categories ?? r?.rows ?? [])),
  })
  const nodes = Array.isArray(tree.data) ? tree.data : []
  const treeState =
    tree.status === 'error' ? 'error'
      : (tree.status === 'loading' || tree.status === 'idle') && nodes.length === 0 ? 'loading'
        : nodes.length === 0 ? 'empty'
          : 'ok'

  // ── Filter state ────────────────────────────────────────────────────────────
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [emailStatuses, setEmailStatuses] = useState([])
  const [sectors, setSectors] = useState([])
  const [regions, setRegions] = useState([])
  const [dedupApply, setDedupApply] = useState(false)

  // ── Live preview state (manual fetch — mirrors v1's debounce exactly) ───────
  const [previewData, setPreviewData] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState(null)
  const debounceRef = useRef(null)

  const [saving, setSaving] = useState(false)

  const toggle = (list, set) => (val) =>
    set(list.includes(val) ? list.filter((v) => v !== val) : [...list, val])

  const buildQueryString = useCallback(() => {
    const p = new URLSearchParams()
    if (emailStatuses.length) p.set('email_status', emailStatuses.join(','))
    if (sectors.length) p.set('sectors', sectors.join(','))
    if (regions.length) p.set('regions', regions.join(','))
    if (dedupApply) p.set('dedup', 'on')
    return p.toString()
  }, [emailStatuses, sectors, regions, dedupApply])

  const fetchPreview = useCallback(async () => {
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const qs = buildQueryString()
      const r = await fetch(`/api/segments/preview${qs ? `?${qs}` : ''}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setPreviewData(await r.json())
    } catch (e) {
      setPreviewError(e?.message ?? String(e))
      setPreviewData(null)
    } finally {
      setPreviewLoading(false)
    }
  }, [buildQueryString])

  // Debounced live count on any filter change (mirrors LIVE_COUNT_DEBOUNCE_MS).
  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(fetchPreview, LIVE_COUNT_DEBOUNCE_MS)
    return () => clearTimeout(debounceRef.current)
  }, [fetchPreview])

  // Translate the picked filters into the persisted segment query tree. Field +
  // op allowlist mirrors the BFF (buildPreviewWhere SEGMENT_ALLOWED): nace_primary
  // → nace_codes[1], region_normalized, email_status. STARTS_WITH matches the
  // preview's prefix LIKE on sectors.
  const buildQueryTree = () => {
    const conditions = []
    // Email status: 'null' (unverified) maps to IS NULL, concrete statuses to
    // IN. Emit BOTH faithfully so the saved segment matches the live preview —
    // previously 'null' was dropped, so a "unverified only" segment silently
    // widened to ALL companies. Combined selection → (IN (...) OR IS NULL).
    const hasNull = emailStatuses.includes('null')
    const nonNull = emailStatuses.filter((s) => s !== 'null')
    const inCond = nonNull.length ? { field: 'email_status', op: 'IN', value: nonNull } : null
    const nullCond = hasNull ? { field: 'email_status', op: 'IS_NULL' } : null
    if (inCond && nullCond) conditions.push({ op: 'OR', conditions: [inCond, nullCond] })
    else if (inCond) conditions.push(inCond)
    else if (nullCond) conditions.push(nullCond)
    if (sectors.length) {
      conditions.push(sectors.length === 1
        ? { field: 'nace_primary', op: 'STARTS_WITH', value: sectors[0] }
        : { op: 'OR', conditions: sectors.map((c) => ({ field: 'nace_primary', op: 'STARTS_WITH', value: c })) })
    }
    if (regions.length) conditions.push({ field: 'region_normalized', op: 'IN', value: regions })
    return { op: 'AND', conditions }
  }

  const canSave = name.trim().length >= MIN_SEGMENT_NAME_LEN && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      const r = await fetch('/api/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          query: buildQueryTree(),
        }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      toast('Segment uložen', 'ok')
      navigate('/segmenty')
    } catch (e) {
      toast(`Chyba: ${e?.message || 'zkus to znovu'}`, 'err')
    } finally {
      setSaving(false)
    }
  }

  const countText = previewError ? '—'
    : previewData ? fmt(previewData.total_matching)
      : previewLoading ? '…' : '—'

  return (
    <div className="app-segment-builder" data-testid="app-segment-builder">
      <div className="app-sb__head">
        <div>
          <h1 className="app-sb__title">Nový segment</h1>
          <span className="app-sb__sub">Nadefinuj filtry a sleduj počet v reálném čase. Náhled vrací jen počty — žádná PII.</span>
        </div>
        <button type="button" className="app-sb__refresh" onClick={() => tree.refresh?.()}
          disabled={tree.status === 'loading'} data-testid="app-sb-refresh" title="Načíst kategorie znovu">
          <RefreshCw size={15} /> Obnovit
        </button>
      </div>

      <div className="app-sb__grid">
        {/* ── Left: filters ─────────────────────────────────────────────────── */}
        <div className="app-sb__main">
          <section className="app-sb-card">
            <label className="app-sb-card__label" htmlFor="app-sb-name">Název segmentu *</label>
            <input
              id="app-sb-name"
              className="app-sb-input"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="Např. Strojírenství — Morava, platné e-maily"
              data-testid="app-sb-name"
              autoFocus
            />
            <input
              className="app-sb-input"
              value={description}
              maxLength={240}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Volitelný interní popis…"
              data-testid="app-sb-desc"
            />
          </section>

          <section className="app-sb-card">
            <div className="app-sb-card__label"><Mail size={13} /> E-mail status</div>
            <div className="app-sb-chips">
              {EMAIL_STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className="app-chip-toggle"
                  aria-pressed={emailStatuses.includes(opt.value)}
                  onClick={() => toggle(emailStatuses, setEmailStatuses)(opt.value)}
                  data-testid="app-sb-email-chip"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          <section className="app-sb-card">
            <div className="app-sb-card__label"><Layers size={13} /> Kategorie (NACE sektor)</div>
            {treeState === 'error' ? (
              <div className="app-empty" data-testid="app-sb-tree-error">
                <div className="app-empty__title">Nepodařilo se načíst kategorie</div>
                <div>{tree.error}</div>
              </div>
            ) : treeState === 'loading' ? (
              <div className="app-sb-tree" data-testid="app-sb-tree">
                {[0, 1, 2, 3, 4].map((i) => <div className="app-sb-skel-row" key={i} />)}
              </div>
            ) : treeState === 'empty' ? (
              <Empty icon={Layers} testid="app-sb-tree-empty"
                title="Žádné kategorie" hint="Registr kategorií je prázdný — segment lze filtrovat statusem a regionem." />
            ) : (
              <div className="app-sb-tree" data-testid="app-sb-tree" role="group" aria-label="Kategorie">
                {nodes.map((cat) => {
                  const val = nodeValue(cat)
                  const active = sectors.includes(val)
                  return (
                    <label key={val || cat.id} className="app-sb-tree__row" data-testid="app-sb-node">
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => toggle(sectors, setSectors)(val)}
                      />
                      <span className="app-sb-tree__name">{nodeLabel(cat)}</span>
                      {cat.company_count != null ? (
                        <span className="app-sb-tree__count">{fmt(cat.company_count)}</span>
                      ) : null}
                    </label>
                  )
                })}
              </div>
            )}
          </section>

          <section className="app-sb-card">
            <div className="app-sb-card__label"><MapPin size={13} /> Regiony (CZ kraje)</div>
            <div className="app-sb-chips">
              {CZ_REGIONS.map((reg) => (
                <button
                  key={reg}
                  type="button"
                  className="app-chip-toggle"
                  aria-pressed={regions.includes(reg)}
                  onClick={() => toggle(regions, setRegions)(reg)}
                  data-testid="app-sb-region-chip"
                >
                  {reg}
                </button>
              ))}
            </div>
          </section>

          <section className="app-sb-card">
            <label className="app-sb-toggle">
              <input type="checkbox" checked={dedupApply}
                onChange={(e) => setDedupApply(e.target.checked)} data-testid="app-sb-dedup" />
              <span>
                <span className="app-sb-toggle__title"><CopyCheck size={13} /> Aplikovat dedup kontrolu</span>
                <span className="app-sb-toggle__hint">Odhadne počet kontaktů přeskočených dedup axemi (DNT, cooldown, lifetime…).</span>
              </span>
            </label>
          </section>
        </div>

        {/* ── Right: live preview ──────────────────────────────────────────── */}
        <aside className="app-sb__aside">
          <div className="app-sb-panel">
            <div className="app-sb-panel__head">
              <Users size={15} /> <span>Živý náhled</span>
              {previewLoading ? <RefreshCw size={13} className="app-sb-spin" /> : null}
            </div>

            <div className="app-sb-count">
              <span className="app-sb-count__n" data-testid="app-sb-count">{countText}</span>
              <span className="app-sb-count__l">kontaktů odpovídá</span>
            </div>

            {previewError ? (
              <div className="app-sb-error" data-testid="app-sb-preview-error">Chyba náhledu: {previewError}</div>
            ) : null}

            {previewData?.skipped_dedup != null ? (
              <div className="app-sb-note">~{fmt(previewData.skipped_dedup)} přeskočeno dedup kontrolou</div>
            ) : null}

            {previewData ? (
              <>
                <div className="app-sb-section-label">Dle e-mail statusu</div>
                <div className="app-sb-breakdown">
                  {EMAIL_STATUS_TILES.map((t) => (
                    <div className={`app-sb-stat ${t.cls}`} key={t.key}>
                      <div className="app-sb-stat__n">{fmt(previewData.breakdown_by_email_status?.[t.key] ?? 0)}</div>
                      <div className="app-sb-stat__l">{t.label}</div>
                    </div>
                  ))}
                </div>

                {previewData.domain_coverage ? (
                  <>
                    <div className="app-sb-section-label">Pokrytí domén</div>
                    <div className="app-sb-domains__stats">
                      <div>
                        <div className="app-sb-domains__n">{fmt(previewData.domain_coverage.unique_domains)}</div>
                        <div className="app-sb-domains__l">unikátních domén</div>
                      </div>
                      <div>
                        <div className="app-sb-domains__n">{fmt(previewData.domain_coverage.max_per_domain)}</div>
                        <div className="app-sb-domains__l">max na doménu</div>
                      </div>
                    </div>

                    {previewData.domain_coverage.max_per_domain > DOMAIN_CONCENTRATION_WARN ? (
                      <div className="app-sb-warn">
                        <AlertTriangle size={13} /> Vysoká koncentrace kontaktů na jednu doménu (fingerprint risk).
                      </div>
                    ) : null}

                    {Array.isArray(previewData.domain_coverage.top_domains) && previewData.domain_coverage.top_domains.length > 0 ? (
                      <div className="app-sb-bars">
                        {previewData.domain_coverage.top_domains.slice(0, TOP_DOMAINS_SHOWN).map((d) => {
                          const max = previewData.domain_coverage.top_domains[0]?.count || 1
                          const pct = Math.max(0, Math.min(100, (d.count / max) * 100))
                          return (
                            <div className="app-sb-bar" key={d.domain}>
                              <div className="app-sb-bar__top">
                                <span className="app-sb-bar__dom">{d.domain}</span>
                                <span className="app-sb-bar__cnt">{fmt(d.count)}</span>
                              </div>
                              <div className="app-sb-bar__track"><div className="app-sb-bar__fill" style={{ width: `${pct}%` }} /></div>
                            </div>
                          )
                        })}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : !previewLoading && !previewError ? (
              <div className="app-sb-note">Vyber filtry pro zobrazení počtu.</div>
            ) : null}

            <button type="button" className="app-sb-save" onClick={save} disabled={!canSave} data-testid="app-sb-save">
              <Save size={15} /> {saving ? 'Ukládám…' : 'Uložit segment'}
            </button>
            {name.trim().length < MIN_SEGMENT_NAME_LEN ? (
              <div className="app-sb-note app-sb-note--center">Zadej název segmentu pro uložení.</div>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  )
}
