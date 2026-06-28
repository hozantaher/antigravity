import { Archive, Share2, EyeOff, X } from 'lucide-react'

// ReplyBulkBar — bulk triage toolbar for the Odpovědi list (#1586 parity).
// Always present while the list has rows: a master "select-all-visible" checkbox
// + count; once ≥1 reply is selected the batch actions appear (Vyřídit / Do CRM
// / Skrýt / zrušit výběr). Mark-handled + hide run immediately (undo via toast);
// Do CRM opens a dialog. All buttons mute while a batch is in flight.
//
// Reuses the existing list checkbox/btn classes loaded via app-odpovedi.css;
// .app-bulkbar* live in app-odpovedi.css (--app-* tokens only). lucide icons, no emoji.
export default function ReplyBulkBar({
  total,
  selectedCount,
  allSelected,
  indeterminate,
  progress,
  onToggleAll,
  onHandle,
  onForward,
  onHide,
  onClear,
}) {
  if (total === 0) return null
  const busy = !!progress
  return (
    <div className="app-bulkbar" data-testid="app-bulkbar">
      <label className="app-bulkbar__all">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => { if (el) el.indeterminate = !!indeterminate }}
          onChange={onToggleAll}
          disabled={busy}
          aria-label="Vybrat všechny zobrazené odpovědi"
          data-testid="app-bulk-selectall"
        />
        <span data-testid="app-bulk-count">
          {selectedCount > 0 ? `${selectedCount} vybráno` : 'Vybrat vše'}
        </span>
      </label>

      {selectedCount > 0 ? (
        <div className="app-bulkbar__acts">
          <button type="button" className="app-btn" onClick={onHandle} disabled={busy} data-testid="app-bulk-handle">
            <Archive size={13} className="app-ico" aria-hidden="true" /> Vyřídit
          </button>
          <button type="button" className="app-btn" onClick={onForward} disabled={busy} data-testid="app-bulk-crm">
            <Share2 size={13} className="app-ico" aria-hidden="true" /> Do CRM
          </button>
          <button type="button" className="app-btn" onClick={onHide} disabled={busy} data-testid="app-bulk-hide">
            <EyeOff size={13} className="app-ico" aria-hidden="true" /> Skrýt
          </button>
          <button
            type="button"
            className="app-btn app-bulkbar__clear"
            onClick={onClear}
            disabled={busy}
            aria-label="Zrušit výběr"
            title="Zrušit výběr"
            data-testid="app-bulk-clear"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {progress ? (
        <span className="app-bulkbar__msg" data-testid="app-bulk-progress">
          {progress.label}: {progress.done}/{progress.total}…
        </span>
      ) : null}
    </div>
  )
}
