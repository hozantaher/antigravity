import { Rocket, ShieldCheck, Download, X, Loader } from 'lucide-react'

const fmt = (n) => new Intl.NumberFormat('cs-CZ').format(Number(n) || 0)

// Toolbar that sits above the firma rows. Always shows the select-all master +
// CSV export (of the current filtered view). Once ≥1 row is selected the bulk
// action bar reveals: launch a campaign from the selection, bulk-verify the
// selected e-mails, and clear. Mirrors the TopTargets select/launch pattern.
export default function FirmyBulkBar({
  rowCount, selectedCount, allSelected, someSelected,
  onToggleAll, onExport, onLaunch, onVerify, onClear, verifying, eligibleVerify,
}) {
  if (rowCount === 0) return null
  return (
    <div className="app-firmy__toolbar" data-testid="app-firmy-toolbar" role="toolbar" aria-label="Hromadné akce">
      <label className="app-firmy__master">
        <input type="checkbox" checked={allSelected}
          ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected }}
          onChange={onToggleAll} data-testid="app-firmy-master"
          aria-label="Vybrat vše viditelné" />
        <span className="app-firmy__mcount" data-testid="app-firmy-bulk-count">
          {selectedCount > 0 ? `${fmt(selectedCount)} vybráno` : 'Vybrat vše'}
        </span>
      </label>
      <button type="button" className="app-fbtn" onClick={onExport}
        data-testid="app-firmy-export" title="Exportovat zobrazené firmy do CSV">
        <Download size={13} /> CSV
      </button>
      {selectedCount > 0 ? (
        <span className="app-firmy__bulkbar" data-testid="app-firmy-bulkbar">
          <button type="button" className="app-fbtn app-fbtn--primary" onClick={onLaunch}
            data-testid="app-firmy-bulk-launch" title="Spustit novou kampaň s vybranými firmami">
            <Rocket size={13} /> Spustit kampaň
          </button>
          <button type="button" className="app-fbtn" onClick={onVerify}
            disabled={verifying || eligibleVerify === 0}
            data-testid="app-firmy-bulk-verify"
            title={eligibleVerify === 0 ? 'Žádná vybraná firma nemá e-mail' : `Ověřit e-mail u ${eligibleVerify} firem`}>
            {verifying
              ? <><Loader size={13} className="app-spin" /> Ověřuji…</>
              : <><ShieldCheck size={13} /> Ověřit e-maily{eligibleVerify > 0 ? ` (${eligibleVerify})` : ''}</>}
          </button>
          <button type="button" className="app-fbtn" onClick={onClear} data-testid="app-firmy-bulk-clear">
            <X size={13} /> Zrušit výběr
          </button>
        </span>
      ) : null}
    </div>
  )
}
