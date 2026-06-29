import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Phone, Ban, History } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useToast } from '../../components/Toast'
import { contactName, emailStatusMeta, crmLabel, contactStatusLabel, campaignContactStatusLabel } from '../lib/contactMeta'
import { vehicleTitle } from '../lib/vehicleMeta'
import { relativeCs } from '../lib/replyMeta'
import { EmptySearch } from '../components/Empty'
import ContactSafetyActions from '../components/kontakty/ContactSafetyActions'
import './app-kontakty.css'

// Kontakty — searchable contact directory on the Antique Alchemist frame.
// Defaults to the ENGAGED universe (in CRM / replied / has a vehicle — ~1.9k of
// 405k) so it never dumps cold contacts; search overrides to reach the full
// base. The detail aside shows the contact card + CRM + the per-contact safety
// cluster (DNT / suppress / verify, GDPR Art. 21) + send history. Twin-parity
// port of src/pages/Contacts.jsx so can be retired. Reuses /api/contacts.
// docs/initiatives/2026-06-20-dashboard-unification.md (Phase 7 — twin parity).

const LIST_LIMIT = 60
const DEBOUNCE_MS = 300

// Server-side status filter (BFF GET /api/contacts supports `status=` exact
// match). Values are the canonical Schema-A contacts.status enum (see
// contactMeta) — covers "bounce history" + suppression/unsub state.
const STATUS_FILTERS = [
  { k: 'valid', label: 'Aktivní' },
  { k: 'bounced', label: 'Bounce' },
  { k: 'suppressed', label: 'Potlačený' },
  { k: 'unsubscribed', label: 'Odhlášen' },
]
// E-mail-verification filter. The BFF GET /api/contacts ignores an email_status
// param (it did in too — v1's chip was a server-side no-op), so applies it
// CLIENT-SIDE over the loaded set — a real, honest refinement instead of a dead
// control.
const EMAIL_FILTERS = [
  { k: 'valid', label: 'Ověřený' },
  { k: 'risky', label: 'Rizikový' },
  { k: 'invalid', label: 'Neplatný' },
  { k: 'catch_all', label: 'Catch-all' },
]

function Tag({ meta, cls, children }) {
  const style = meta ? { color: meta.fg, background: meta.bg } : undefined
  return <span className={`app-tag${cls ? ' ' + cls : ''}`} style={style}>{children ?? meta?.label}</span>
}

function Row({ c, active, selected, onOpen, onToggleSel }) {
  const es = emailStatusMeta(c.email_status)
  const crm = crmLabel(c)
  return (
    <div className={`app-krow-wrap${active ? ' app-krow-wrap--active' : ''}`}>
      <input type="checkbox" className="app-krow__check" checked={selected}
        onChange={() => onToggleSel(c.id)} aria-label={`Vybrat ${contactName(c)}`}
        data-testid="app-contact-checkbox" />
      <button type="button" className="app-krow" aria-current={active ? 'true' : undefined}
        onClick={() => onOpen(c.id)} data-testid="app-contact-row">
        <div className="app-krow__name">{contactName(c)}</div>
        <div className="app-krow__co">{c.company_name || '—'}</div>
        <div className="app-krow__tags">
          {c.phone ? <Tag cls="app-tag--phone"><Phone size={10} className="app-ico" /></Tag> : null}
          {es ? <Tag meta={es} /> : null}
          {crm ? <Tag cls="app-tag--crm">{crm}</Tag> : null}
          {c.total_sent > 0 ? <Tag cls="app-tag--sent">{c.total_sent}× osloven</Tag> : null}
        </div>
      </button>
    </div>
  )
}

// Per-contact send-timing + reset (#1403). The operator sees when this contact
// is next scheduled in a campaign and can pull it to NOW (two-step confirm,
// send-adjacent). Replaces the raw-SQL workaround; reuses the audited BFF
// PATCH /api/campaigns/:id/contacts/:contact_id/reset-next-send. The
// X-Confirm-Send header here is REQUIRED by that send-adjacent endpoint — do not
// remove (the contact PATCH endpoints below intentionally carry no such header,
// matching v1).
function CampaignTiming({ contactId, campaigns, onReset }) {
  const [confirmId, setConfirmId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  if (!campaigns || campaigns.length === 0) return null
  const reset = async (campaignId) => {
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`/api/campaigns/${campaignId}/contacts/${contactId}/reset-next-send`,
        { method: 'PATCH', headers: { 'X-Confirm-Send': 'yes' } })
      if (!r.ok) throw new Error(`reset ${r.status}`)
      setConfirmId(null); setMsg('Přeřazeno na teď — pošle se v dalším ticku.')
      await onReset?.()
    } catch { setMsg('Reset se nezdařil — zkus znovu.') } finally { setBusy(false) }
  }
  return (
    <div className="app-kd__section" data-testid="app-contact-campaigns">
      <div className="app-kd__label">Kampaň</div>
      {campaigns.map((cc) => {
        const future = cc.next_send_at && new Date(cc.next_send_at) > new Date()
        // relativeCs assumes the past ("před X"); a future schedule reads wrong
        // as "právě teď", so format future sends as an explicit date.
        const when = !cc.next_send_at ? ''
          : future ? ` · naplánováno ${new Date(cc.next_send_at).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })}`
          : ` · ${relativeCs(cc.next_send_at)}`
        return (
          <div key={cc.campaign_id} className="app-kd__row" style={{ alignItems: 'center' }}>
            <dt>{cc.campaign_name || `#${cc.campaign_id}`} · {campaignContactStatusLabel(cc.status)}{when}</dt>
            <dd>
              {future ? (
                confirmId === cc.campaign_id ? (
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    <button type="button" className="app-kd__reset app-kd__reset--go" disabled={busy}
                      onClick={() => reset(cc.campaign_id)} data-testid="app-timing-confirm">Odeslat teď</button>
                    <button type="button" className="app-kd__reset" disabled={busy}
                      onClick={() => setConfirmId(null)} data-testid="app-timing-cancel">Zpět</button>
                  </span>
                ) : (
                  <button type="button" className="app-kd__reset" onClick={() => setConfirmId(cc.campaign_id)}
                    data-testid="app-timing-reset">Odeslat teď</button>
                )
              ) : null}
            </dd>
          </div>
        )
      })}
      {msg ? <div style={{ fontSize: 'var(--app-text-xs)', color: 'var(--app-text-muted)', marginTop: 4 }} data-testid="app-timing-msg">{msg}</div> : null}
    </div>
  )
}

function SendHistory({ sends }) {
  const list = Array.isArray(sends) ? sends : []
  return (
    <div className="app-kd__section" data-testid="app-contact-sends">
      <div className="app-kd__label"><History size={11} className="app-ico" /> Historie odesílání{list.length ? ` (${list.length})` : ''}</div>
      {list.length === 0 ? (
        <div className="app-kd__send-empty">Žádné odeslané zprávy.</div>
      ) : (
        list.map((s, i) => (
          <div className="app-kd__send" key={s.id ?? i} data-testid="app-contact-send">
            <div className="app-kd__send-subj">{s.subject || '(bez předmětu)'}</div>
            <div className="app-kd__send-meta">
              <span>{s.mailbox_email || '—'}</span>
              <span>{s.sent_at ? new Date(s.sent_at).toLocaleDateString('cs-CZ') : '—'}</span>
            </div>
            {s.status && s.status !== 'sent' ? (
              <div className="app-kd__send-status"
                style={{ color: s.status === 'bounced' ? 'var(--app-negative)' : 'var(--app-text-muted)' }}>{s.status}</div>
            ) : null}
          </div>
        ))
      )}
    </div>
  )
}

function DetailAside({ id, onListRefresh }) {
  // Fetch the contact BY ID so a deep-link (?id=…) works even when the contact
  // isn't in the loaded engaged/search list (405k base) — and so cross-links
  // from other surfaces (e.g. Vozidlo → kontakt) land on a populated card.
  // The response also carries send_history + campaigns + dnt (BFF contacts.js).
  const detail = useResource(id ? `/api/contacts/${encodeURIComponent(id)}` : null, { enabled: !!id })
  // The contact's vehicles — the kontakt→vozidlo edge (reverse of vozidlo→kontakt).
  const veh = useResource(id ? `/api/vehicles?contact_id=${encodeURIComponent(id)}&limit=20` : null, { enabled: !!id })
  // The contact's replies — the kontakt→odpověď edge.
  const reps = useResource(id ? `/api/replies?contact_id=${encodeURIComponent(id)}&limit=20` : null, { enabled: !!id })
  if (!id) {
    return (
      <div className="app-empty" data-testid="app-contact-empty">
        <div className="app-empty__title">Vyber kontakt</div>
        <div>Zvol kontakt vlevo a uvidíš jeho kartu.</div>
      </div>
    )
  }
  if (detail.status === 'error') {
    return <div className="app-empty"><div className="app-empty__title">Nepodařilo se načíst</div><div>{detail.error}</div></div>
  }
  if (detail.status !== 'ok' || !detail.data) {
    return <div className="app-empty"><div className="app-empty__title">Načítám…</div></div>
  }
  const c = detail.data
  const es = emailStatusMeta(c.email_status)
  // After a safety mutation: re-fetch this contact's detail (so the aside
  // reflects the new state) + the list (so the row chip updates).
  const handleMutated = () => { detail.refresh?.(); onListRefresh?.() }
  const rows = [
    ['E-mail', c.email],
    // Telefon as a click-to-call link — výkup closes by phone (#1586). Saved via
    // the reply ActionRail (M2.2); show it here so the operator can dial from the
    // contact record too.
    ['Telefon', c.phone ? <a href={`tel:${c.phone}`} className="app-kd__tel" data-testid="app-contact-phone"><Phone size={11} className="app-ico" /> {c.phone}</a> : null],
    // Firma → clickable company (navigate the data graph by edges, #1586). Links
    // by IČO which Firmy resolves; falls back to plain text without an IČO.
    ['Firma', c.ico
      ? <Link to={`/firmy?ico=${encodeURIComponent(c.ico)}`} className="app-kd__link" data-testid="app-contact-company-link">{c.company_name || c.ico} →</Link>
      : c.company_name],
    ['Stav', contactStatusLabel(c.status)],
    ['Osloven', c.total_sent != null ? `${c.total_sent}×` : null],
    ['Poslední kontakt', c.last_contact_at ? relativeCs(c.last_contact_at) : null],
    ['Ověření e-mailu', c.email_verified_at ? relativeCs(c.email_verified_at) : null],
  ].filter(([, v]) => v != null && v !== '')
  const crm = c.crm || null
  return (
    <div className="app-kontakty__pane" data-testid="app-contact-detail">
      <h2 className="app-kd__name">{contactName(c)}</h2>
      <div className="app-kd__email">{c.email}</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {es ? <Tag meta={es} /> : null}
        {crmLabel(c) ? <Tag cls="app-tag--crm">{crmLabel(c)}</Tag> : null}
        {c.suppressed ? <Tag cls="app-tag--sent">Suppression</Tag> : null}
      </div>

      {/* Safety + GDPR cluster — DNT (Art. 21), suppress, verify e-mail. */}
      <ContactSafetyActions contact={c} onMutated={handleMutated} />

      {/* S3: sections flow into 2 columns on a wide detail pane (was one narrow
          column leaving an empty right third on a laptop). Collapses to 1. */}
      <div className="app-kd__sections">
      <div className="app-kd__section">
        <div className="app-kd__label">Kontakt</div>
        <dl style={{ margin: 0 }}>{rows.map(([k, v]) => <div className="app-kd__row" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      </div>
      {crm ? (
        <div className="app-kd__section">
          <div className="app-kd__label">CRM</div>
          <dl style={{ margin: 0 }}>
            {[['Vztah', crm.crm_relationship], ['Status', crm.crm_status], ['Vlastník', crm.owner_email], ['Poslední aktivita', crm.last_activity ? relativeCs(crm.last_activity) : null]]
              .filter(([, v]) => v).map(([k, v]) => <div className="app-kd__row" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
          {c.crm_client_id ? (
            <Link to={`/crm?id=${c.crm_client_id}`} className="app-kd__link" data-testid="app-contact-crm-link">Zobrazit v CRM →</Link>
          ) : null}
        </div>
      ) : null}
      <CampaignTiming contactId={c.id} campaigns={c.campaigns} onReset={detail.refresh} />
      {(veh.data?.rows || []).length > 0 ? (
        <div className="app-kd__section" data-testid="app-contact-vehicles">
          <div className="app-kd__label">Vozidla ({veh.data.rows.length})</div>
          {veh.data.rows.map((v) => (
            <Link key={v.id} to={`/vozidla?id=${v.id}`} className="app-kd__veh" data-testid="app-contact-vehicle">
              {vehicleTitle(v)} →
            </Link>
          ))}
        </div>
      ) : null}
      {(reps.data?.rows || []).length > 0 ? (
        <div className="app-kd__section" data-testid="app-contact-replies">
          <div className="app-kd__label">Odpovědi ({reps.data.rows.length})</div>
          {reps.data.rows.map((r) => (
            <Link key={r.id} to={`/odpovedi?vse=1&id=${r.id}`} className="app-kd__veh" data-testid="app-contact-reply">
              {r.subject || '(bez předmětu)'} · {relativeCs(r.received_at)} →
            </Link>
          ))}
        </div>
      ) : null}

      {/* Send history — the per-contact send_events drawer (BFF returns last 20). */}
      <SendHistory sends={c.send_history} />
      </div>
    </div>
  )
}

export default function Kontakty() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const activeId = params.get('id')
  const q = params.get('q') || ''
  const statusFilter = params.get('status') || ''   // server-side
  const estatus = params.get('estatus') || ''       // client-side (loaded set)
  // engaged default applies only in plain-browse mode: a search or a status
  // filter both reach the full base instead.
  const engagedOnly = !q && !statusFilter && params.get('vse') !== '1'

  const [draft, setDraft] = useState(q)
  useEffect(() => {
    const t = setTimeout(() => {
      // Read the LIVE url at fire-time (not the captured `params`) so a change
      // made during the debounce window — e.g. clicking a row to set ?id, or
      // toggling Zapojené/Vše — isn't clobbered by this stale snapshot.
      const next = new URLSearchParams(window.location.search)
      if (draft) next.set('q', draft); else next.delete('q')
      setParams(next, { replace: true })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // Sync the search box when `q` changes externally (Back / "Vymazat hledání"),
  // not from typing — otherwise the input keeps a stale draft after the reset.
  useEffect(() => { setDraft(q) }, [q])

  const url = `/api/contacts?limit=${LIST_LIMIT}`
    + (q ? `&search=${encodeURIComponent(q)}` : '')
    + (statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : '')
    + (engagedOnly ? '&engaged=1' : '')
  const list = useResource(url, { pollMs: 45_000, pauseHidden: true })
  const rows = list.data?.rows || []
  // Client-side e-mail-verification refinement over the loaded set (the BFF
  // ignores an email_status param — same as v1, where the chip did nothing).
  const shown = estatus ? rows.filter((c) => (c.email_status || '') === estatus) : rows
  // True base count for the "Vše" label — independent of the engaged filter, so
  // it doesn't mislabel the engaged subset (~1.9k) as the full base (~405k). A
  // 1-row probe; we only read `.total` (the unfiltered COUNT).
  const baseCount = useResource('/api/contacts?limit=1', { pollMs: 0, pauseHidden: true })

  // ── Multi-select + bulk-suppress (twin-parity with v1). Same endpoint +
  //    headers used (PATCH {status} with Content-Type only — no X-Confirm-Send;
  //    used none and the BFF requires none). window.confirm preserved. ──────
  const [sel, setSel] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const toggleSel = (id) => setSel((prev) => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  const clearSel = () => setSel(new Set())
  const allSelected = shown.length > 0 && shown.every((c) => sel.has(c.id))
  const toggleSelectAll = () => { if (allSelected) clearSel(); else setSel(new Set(shown.map((c) => c.id))) }

  const bulkSuppress = async () => {
    const ids = Array.from(sel)
    if (!ids.length) return
    const n = ids.length
    const noun = n === 1 ? 'kontakt' : n < 5 ? 'kontakty' : 'kontaktů'
    if (!window.confirm(`Potlačit ${n} ${noun}? Zastaví to outreach na vybrané kontakty.`)) return
    setBulkBusy(true)
    try {
      const results = await Promise.allSettled(ids.map((id) =>
        fetch(`/api/contacts/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'suppressed' }),
        }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return id })
      ))
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const fail = results.length - ok
      if (ok) toast(`${ok} ${ok === 1 ? 'kontakt potlačen' : 'kontaktů potlačeno'}${fail ? `, ${fail} selhalo` : ''}`, fail ? 'warn' : 'ok')
      else toast('Potlačení selhalo', 'err')
      clearSel()
      list.refresh?.()
    } catch (e) {
      toast(e?.message || 'Chyba při potlačování', 'err')
    } finally { setBulkBusy(false) }
  }

  const open = (id) => { const n = new URLSearchParams(params); n.set('id', String(id)); setParams(n) }
  // setVse re-scopes the loaded set (engaged↔all) and setEstatus re-scopes the
  // visible `shown` subset; both must clear the selection (like setStatusFilter)
  // so bulkSuppress can't act on contacts that scrolled out of the new view.
  const setVse = (all) => { const n = new URLSearchParams(params); if (all) n.set('vse', '1'); else n.delete('vse'); setParams(n, { replace: true }); clearSel() }
  const setStatusFilter = (val) => { const n = new URLSearchParams(params); if (val) n.set('status', val); else n.delete('status'); setParams(n, { replace: true }); clearSel() }
  const setEstatus = (val) => { const n = new URLSearchParams(params); if (val) n.set('estatus', val); else n.delete('estatus'); setParams(n, { replace: true }); clearSel() }

  const listLoading = list.status === 'loading' && rows.length === 0

  return (
    <div className="app-kontakty" data-testid="app-kontakty">
      <div className="app-kontakty__list">
        <div className="app-kontakty__search">
          <input value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="Hledat jméno, e-mail, firmu…" data-testid="app-contact-search" />
        </div>
        <div className="app-kontakty__filters">
          {!q && !statusFilter && (
            <div className="app-kfilt-row">
              <button type="button" className="app-chip-toggle" aria-pressed={engagedOnly}
                onClick={() => setVse(false)} data-testid="app-filter-engaged">Zapojené</button>
              <button type="button" className="app-chip-toggle" aria-pressed={!engagedOnly}
                onClick={() => setVse(true)} data-testid="app-filter-all">Vše ({baseCount.data?.total ?? '—'})</button>
            </div>
          )}
          <div className="app-kfilt-row" data-testid="app-filter-status-group">
            {STATUS_FILTERS.map((f) => (
              <button key={f.k} type="button" className="app-chip-toggle" aria-pressed={statusFilter === f.k}
                onClick={() => setStatusFilter(statusFilter === f.k ? '' : f.k)} data-testid="app-filter-status">{f.label}</button>
            ))}
          </div>
          <div className="app-kfilt-row" data-testid="app-filter-email-group">
            {EMAIL_FILTERS.map((f) => (
              <button key={f.k} type="button" className="app-chip-toggle" aria-pressed={estatus === f.k}
                onClick={() => setEstatus(estatus === f.k ? '' : f.k)} data-testid="app-filter-email">{f.label}</button>
            ))}
          </div>
        </div>

        {shown.length > 0 && (
          <div className="app-khead" data-testid="app-kontakty-listhead">
            <label className="app-khead__all">
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                aria-label="Vybrat vše na stránce" data-testid="app-contact-selectall" />
              <span>{sel.size > 0 ? `${sel.size} vybráno` : 'Vybrat vše'}</span>
            </label>
            {sel.size > 0 && (
              <div className="app-khead__bulk" data-testid="app-bulk-bar">
                <button type="button" className="app-kbtn app-kbtn--danger" onClick={bulkSuppress}
                  disabled={bulkBusy} data-testid="app-bulk-suppress">
                  <Ban size={12} className="app-ico" /> {bulkBusy ? 'Potlačuji…' : 'Potlačit'}
                </button>
                <button type="button" className="app-kbtn" onClick={clearSel} data-testid="app-bulk-clear">Zrušit výběr</button>
              </div>
            )}
          </div>
        )}

        <div className="app-kontakty__rows">
          {listLoading ? (
            <>{[0, 1, 2, 3, 4].map((i) => <div className="app-skeleton-row" key={i} />)}</>
          ) : list.status === 'error' ? (
            <div className="app-empty"><div className="app-empty__title">Nepodařilo se načíst</div><div>{list.error}</div></div>
          ) : rows.length === 0 ? (
            <EmptySearch
              testid="app-contacts-list-empty"
              title={q ? 'Nic neodpovídá' : 'Žádné kontakty'}
              hint={q ? `Pro „${q}" nic — zkus jiný výraz nebo přepni na Vše.` : 'V zapojené knize zatím nikdo není.'}
              action={q ? { to: '/kontakty', label: 'Vymazat hledání' } : undefined}
            />
          ) : shown.length === 0 ? (
            <EmptySearch
              testid="app-contacts-filter-empty"
              title="Nic neodpovídá filtru"
              hint="Žádný z načtených kontaktů nemá tento stav ověření. Zruš filtr ověření."
              action={{ onClick: () => setEstatus(''), label: 'Zrušit filtr ověření' }}
            />
          ) : (
            shown.map((c) => (
              <Row key={c.id} c={c} active={String(c.id) === activeId}
                selected={sel.has(c.id)} onOpen={open} onToggleSel={toggleSel} />
            ))
          )}
        </div>
      </div>
      <DetailAside id={activeId} onListRefresh={() => list.refresh?.()} />
    </div>
  )
}
