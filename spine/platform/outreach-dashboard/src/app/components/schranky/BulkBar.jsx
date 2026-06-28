import { Play, Pause, RefreshCw, X } from 'lucide-react'

// BulkBar — bulk action toolbar for the selected mailboxes. Visible only when
// count > 0. Pause/Resume go through a confirm dialog in the page (the BFF
// bulk-pause / bulk-resume endpoints require the X-Confirm-Send: yes header).
// Full-check is read-only (re-runs health probes, no state change).
export default function BulkBar({ count, onPause, onResume, onCheck, onClear }) {
  if (count <= 0) return null
  return (
    <div className="app-sb-bulkbar" data-testid="app-schranky-bulkbar">
      <span className="app-sb-bulkbar__count" data-testid="app-schranky-bulkbar-count">{count} vybráno</span>
      <div className="app-sb-bulkbar__spacer" />
      <button type="button" className="app-sb-btn" onClick={onResume} data-testid="app-schranky-bulk-resume">
        <Play size={14} strokeWidth={1.8} /> Aktivovat
      </button>
      <button type="button" className="app-sb-btn app-sb-btn--danger" onClick={onPause} data-testid="app-schranky-bulk-pause">
        <Pause size={14} strokeWidth={1.8} /> Pozastavit
      </button>
      <button type="button" className="app-sb-btn" onClick={onCheck} data-testid="app-schranky-bulk-check">
        <RefreshCw size={14} strokeWidth={1.8} /> Full-check
      </button>
      <button type="button" className="app-sb-btn app-sb-btn--ghost" onClick={onClear} data-testid="app-schranky-bulk-clear">
        <X size={14} strokeWidth={1.8} /> Zrušit výběr
      </button>
    </div>
  )
}
