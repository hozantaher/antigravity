// Analytika — Trendy tab. Read-only deliverability panels (M1/M2/M4/M5 + L2)
// against the SAME BFF endpoints. Each panel = fleet summary + per-mailbox /
// per-template table with a time-window toggle. Drilldown row-nav is dropped
// (no mailbox/template detail routes exist yet — Phase 6).

import { useState } from 'react'
import { AlertTriangle, FileText } from 'lucide-react'
import { useResource } from '../../../hooks/useResource'
import { Card, Chips, Pill, Async, fmt, POLL_MS } from './Charts'

// Window option sets (labels mirror v1: Dnes / Týden / Měsíc / Vše).
const W3 = [{ value: '24h', label: 'Dnes' }, { value: '7d', label: 'Týden' }, { value: '30d', label: 'Měsíc' }]
const W2 = [{ value: '7d', label: 'Týden' }, { value: '30d', label: 'Měsíc' }]
const W4 = [...W3, { value: 'all', label: 'Vše' }]

// Named semantic thresholds — no magic numbers (feedback_no_magic_thresholds).
const REP_GOOD = 85, REP_OK = 70
const TPL_RR_GOOD = 5, TPL_RR_OK = 2
function repTone(s) { return s >= REP_GOOD ? 'ok' : s >= REP_OK ? 'warn' : 'err' }
function rrTone(rr) { return rr >= TPL_RR_GOOD ? 'ok' : rr >= TPL_RR_OK ? 'warn' : 'neutral' }
const Warn = () => <AlertTriangle size={12} className="app-ico app-anl-warn-ico" />

function BouncePanel() {
  const [w, setW] = useState('7d')
  const res = useResource(`/api/mailboxes/bounce-stats?window=${w}`, { pollMs: POLL_MS, pauseHidden: true })
  const d = res.data
  return (
    <Card title="Bounce rate dle schránky" testid="app-analytika-bounce"
      note={d?.threshold_pct ? `alert ≥ ${d.threshold_pct} %` : null}
      tools={<Chips value={w} onChange={setW} options={W3} label="Okno" testidPrefix="app-analytika-bounce-w" />}>
      <Async res={res} hasData={!!d}>
        {d ? (
          <>
            <div className="app-anl-fleet">
              Flotila: {fmt(d.fleet?.sent)} odesláno, {fmt(d.fleet?.bounced)} odraženo →{' '}
              <strong className={`app-anl-rr--${d.fleet?.bounce_rate_pct >= d.threshold_pct ? 'err' : 'ok'}`}>{d.fleet?.bounce_rate_pct} %</strong>
            </div>
            <Table cols={['Schránka', 'Stav', 'Odesláno', 'Odraženo', 'Rate']} numFrom={2}
              rows={d.mailboxes} empty="Žádné produkční schránky"
              render={(m) => (
                <tr key={m.mailbox_id}>
                  <td className="app-anl-table__name">{m.from_address}</td>
                  <td><Pill tone={m.status === 'active' ? 'ok' : 'neutral'}>{m.status}</Pill></td>
                  <td className="app-anl-table__num">{fmt(m.sent)}</td>
                  <td className="app-anl-table__num">{fmt(m.bounced)}</td>
                  <td className={`app-anl-table__num ${m.alert_threshold_breached ? 'app-anl-rr--err' : m.bounce_rate_pct > 0 ? 'app-anl-rr--warn' : 'app-anl-muted'}`}>
                    {m.bounce_rate_pct} % {m.alert_threshold_breached ? <Warn /> : null}
                  </td>
                </tr>
              )} />
          </>
        ) : null}
      </Async>
    </Card>
  )
}

function SpamPanel() {
  const [w, setW] = useState('7d')
  const res = useResource(`/api/mailboxes/spam-complaint-stats?window=${w}`, { pollMs: POLL_MS, pauseHidden: true })
  const d = res.data
  return (
    <Card title="Stížnosti / odhlášení dle schránky" testid="app-analytika-spam"
      note={d?.threshold_pct ? `alert ≥ ${d.threshold_pct} %` : null}
      tools={<Chips value={w} onChange={setW} options={W3} label="Okno" testidPrefix="app-analytika-spam-w" />}>
      <Async res={res} hasData={!!d}>
        {d ? (
          <>
            <div className="app-anl-fleet">
              Flotila: {fmt(d.fleet?.sent)} odesláno, {fmt(d.fleet?.complaints)} stížností →{' '}
              <strong className={`app-anl-rr--${d.fleet?.complaint_rate_pct >= d.threshold_pct ? 'err' : 'ok'}`}>{d.fleet?.complaint_rate_pct} %</strong>
              {d.complaint_classifications?.length ? <span className="app-anl-muted"> (klasifikace: {d.complaint_classifications.join(', ')})</span> : null}
            </div>
            <Table cols={['Schránka', 'Stav', 'Odesláno', 'Stížnosti', 'Rate']} numFrom={2}
              rows={d.mailboxes} empty="Žádné produkční schránky"
              render={(m) => (
                <tr key={m.mailbox_id}>
                  <td className="app-anl-table__name">{m.from_address}</td>
                  <td><Pill tone={m.status === 'active' ? 'ok' : 'neutral'}>{m.status}</Pill></td>
                  <td className="app-anl-table__num">{fmt(m.sent)}</td>
                  <td className="app-anl-table__num">{fmt(m.complaints)}</td>
                  <td className={`app-anl-table__num ${m.alert_threshold_breached ? 'app-anl-rr--err' : m.complaint_rate_pct > 0 ? 'app-anl-rr--warn' : 'app-anl-muted'}`}>
                    {m.complaint_rate_pct} % {m.alert_threshold_breached ? <Warn /> : null}
                  </td>
                </tr>
              )} />
          </>
        ) : null}
      </Async>
    </Card>
  )
}

function ReputationPanel() {
  const [w, setW] = useState('7d')
  const res = useResource(`/api/mailboxes/reputation-score?window=${w}`, { pollMs: POLL_MS, pauseHidden: true })
  const d = res.data
  const wt = d?.weights
  return (
    <Card title="Reputace schránek (kompozit)" testid="app-analytika-reputation"
      note={d?.threshold_score ? `alert < ${d.threshold_score}` : null}
      tools={<Chips value={w} onChange={setW} options={W2} label="Okno" testidPrefix="app-analytika-reputation-w" />}>
      <Async res={res} hasData={!!d}>
        {d ? (
          <>
            <div className="app-anl-fleet">
              Flotila: {d.fleet?.mailbox_count} schránek, průměr{' '}
              <strong className={`app-anl-rr--${d.fleet?.avg_score < d.threshold_score ? 'err' : 'ok'}`}>{d.fleet?.avg_score}</strong>, {d.fleet?.below_threshold} pod prahem
              {wt ? <span className="app-anl-muted"> · váhy: bounce {Math.round(wt.bounce * 100)} % + spam {Math.round(wt.spam * 100)} % + doručení {Math.round(wt.delivery * 100)} % + auth {Math.round(wt.auth * 100)} %</span> : null}
            </div>
            <Table cols={['Schránka', 'Skóre', 'Bounce', 'Spam', 'Doručení', 'Auth']} numFrom={1}
              rows={d.mailboxes} empty="Žádné produkční schránky"
              render={(m) => (
                <tr key={m.mailbox_id}>
                  <td className="app-anl-table__name">{m.from_address}</td>
                  <td className={`app-anl-table__num app-anl-rr--${repTone(m.reputation_score)}`}>{m.reputation_score} {m.alert_threshold_breached ? <Warn /> : null}</td>
                  <td className="app-anl-table__num app-anl-muted">{m.sub_scores?.bounce}</td>
                  <td className="app-anl-table__num app-anl-muted">{m.sub_scores?.spam}</td>
                  <td className="app-anl-table__num app-anl-muted">{m.sub_scores?.delivery}</td>
                  <td className="app-anl-table__num app-anl-muted">{m.sub_scores?.auth}</td>
                </tr>
              )} />
          </>
        ) : null}
      </Async>
    </Card>
  )
}

function TemplatesPanel() {
  const [w, setW] = useState('7d')
  const res = useResource(`/api/templates/metrics?window=${w}`, { pollMs: POLL_MS, pauseHidden: true })
  const d = res.data
  const tpls = d?.templates || []
  return (
    <Card title="Výkon šablon" icon={FileText} testid="app-analytika-templates"
      note={d?.spam_alert_threshold_pct != null ? `spam alert ≥ ${d.spam_alert_threshold_pct} %` : null}
      tools={<Chips value={w} onChange={setW} options={W2} label="Okno" testidPrefix="app-analytika-templates-w" />}>
      <Async res={res} hasData={!!d}>
        {tpls.length === 0 ? (
          <div className="app-anl-msg">Žádné šablony s odeslanými e-maily v tomto okně.</div>
        ) : (
          <Table cols={['Šablona', 'Odesláno', 'Open %', 'Reply %', 'Spam %']} numFrom={1}
            rows={tpls} empty="Žádné šablony"
            render={(t) => (
              <tr key={t.template_name}>
                <td className="app-anl-table__name">{t.template_name} {t.alert_threshold_breached ? <Warn /> : null}</td>
                <td className="app-anl-table__num">{fmt(t.sent_count)}</td>
                <td className="app-anl-table__num app-anl-muted">{t.open_rate_pct?.toFixed(1)} %</td>
                <td className={`app-anl-table__num app-anl-rr--${rrTone(t.reply_rate_pct)}`}>{t.reply_rate_pct?.toFixed(1)} %</td>
                <td className={`app-anl-table__num ${t.alert_threshold_breached ? 'app-anl-rr--err' : t.spam_rate_pct > 0 ? 'app-anl-rr--warn' : 'app-anl-muted'}`}>{t.spam_rate_pct?.toFixed(2)} %</td>
              </tr>
            )} />
        )}
      </Async>
    </Card>
  )
}

function BlacklistPanel() {
  const [w, setW] = useState('7d')
  const res = useResource(`/api/mailboxes/blacklist-alerts?window=${w}`, { pollMs: POLL_MS, pauseHidden: true })
  const d = res.data
  return (
    <Card title="Blacklist hity" testid="app-analytika-blacklist"
      note={d?.fleet?.active > 0 ? `${d.fleet.active} aktivních` : null}
      tools={<Chips value={w} onChange={setW} options={W4} label="Okno" testidPrefix="app-analytika-blacklist-w" />}>
      <Async res={res} hasData={!!d}>
        {d ? (
          <>
            <div className="app-anl-fleet">
              Flotila: {fmt(d.fleet?.total)} hitů celkem,{' '}
              <strong className={`app-anl-rr--${d.fleet?.active > 0 ? 'err' : 'ok'}`}>{d.fleet?.active} aktivních</strong>, {d.fleet?.resolved} vyřešených
            </div>
            {d.top_zones?.length ? (
              <div className="app-anl-fleet">Top zóny: {d.top_zones.map((z) => `${z.zone} (${z.count})`).join(', ')}</div>
            ) : null}
            {d.mailboxes?.length === 0 ? (
              <div className="app-anl-msg app-anl-msg--ok">Žádný hit v tomto okně.</div>
            ) : (
              <Table cols={['Schránka', 'Aktivní', 'Vyřešené', 'Naposledy']} numFrom={1}
                rows={d.mailboxes} empty="Žádný hit"
                render={(m) => (
                  <tr key={m.mailbox_id}>
                    <td className="app-anl-table__name">{m.from_address}</td>
                    <td className={`app-anl-table__num ${m.active > 0 ? 'app-anl-rr--err' : 'app-anl-muted'}`}>{m.active}</td>
                    <td className="app-anl-table__num app-anl-muted">{m.resolved}</td>
                    <td className="app-anl-muted app-anl-table__when">{m.most_recent_at ? new Date(m.most_recent_at).toLocaleString('cs-CZ') : '—'}</td>
                  </tr>
                )} />
            )}
          </>
        ) : null}
      </Async>
    </Card>
  )
}

// Shared calm table. `numFrom` = first column index that is right-aligned.
function Table({ cols, rows, render, empty, numFrom = 99 }) {
  return (
    <div className="app-anl-tablewrap">
      <table className="app-anl-table">
        <thead>
          <tr>{cols.map((c, i) => <th key={c} className={i >= numFrom ? 'app-anl-table__num' : undefined}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {(!rows || rows.length === 0)
            ? <tr><td colSpan={cols.length} className="app-anl-msg">{empty}</td></tr>
            : rows.map(render)}
        </tbody>
      </table>
    </div>
  )
}

export default function AnalytikaTrendy() {
  return (
    <div className="app-anl-panel app-anl-panel--stack" role="tabpanel" data-testid="app-analytika-panel-trendy">
      <BouncePanel />
      <SpamPanel />
      <ReputationPanel />
      <TemplatesPanel />
      <BlacklistPanel />
    </div>
  )
}
