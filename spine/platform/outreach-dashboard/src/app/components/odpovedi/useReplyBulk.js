import { useState, useEffect, useCallback } from 'react'

// useReplyBulk — bulk triage actions for the Odpovědi list, at feature
// parity with the pages/Replies.jsx bulk bar so can be retired.
//
// REUSES the exact BFF endpoints (no new backend, no /api/leads):
//   - mark handled / hide → per-row PATCH /api/replies/:id   { handled:true }
//                           (setReplyHandled routes pos→reply_inbox, neg→unmatched)
//   - undo                → POST     /api/replies/bulk-revert { reverts:[…] }
//   - forward to CRM      → POST     /api/replies/:id/forward-to-crm { notes, crm_url }
//                           (negative/unmatched ids have no CRM row → PATCH handled)
//   - suppression gate    → POST     /api/replies/bulk-suppress-check { ids }  (fail-open)
//
// Headers match verbatim: Content-Type: application/json only. NONE of these
// routes gate on X-Confirm-Send (verified server-side in src/server-routes/
// replies.js — only the operator-settings / mailbox-state mutations do), so we
// add none here. The two-step operator consent for destructive ops lives in the
// confirm dialogs + the undo toast. Mutations surface via useToast(); undo rides
// the toast secondaryAction, exactly like v1.

// No magic numbers (feedback_no_magic_thresholds T0). Concurrency cap mirrors
// the useRepliesBulkLoop (4 keeps BFF audit-log load sane while finishing a
// 50-row page in <2s). Suppression warn threshold mirrors (warn on any hit).
const BULK_CONCURRENCY_CAP = 4
const SUPPRESSION_WARN_THRESHOLD = 0

const sourceOf = (id) => (Number(id) > 0 ? 'reply_inbox' : 'unmatched_inbound')

// Minimal fetch wrapper — same shape + headers as src/lib/api.js (the canonical
// wrapper) without importing it, keeping the surface decoupled. Throws an
// Error carrying .status on non-2xx so callers branch like did.
async function mutate(path, { method, body } = {}) {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    let detail = null
    try { detail = await r.json() } catch { /* non-JSON */ }
    const e = new Error(detail?.error || `${r.status} ${r.statusText}`)
    e.status = r.status
    throw e
  }
  return r.json().catch(() => ({}))
}

export function useReplyBulk({ rows, resetKey, toast, onChanged }) {
  // Selection is keyed by String(id) so it compares cleanly with the URL ?id=
  // and so negative (unmatched) ids round-trip safely.
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [progress, setProgress] = useState(null) // null | { done, total, label }

  // Reset the whole selection when the filter (mode) changes — a selection is
  // filter-scoped and must not bleed across chips.
  useEffect(() => { setSelectedIds(new Set()) }, [resetKey])

  // Prune ids that have left the visible list (e.g. became handled on refresh).
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const visible = new Set(rows.map((r) => String(r.id)))
      let mutated = false
      const next = new Set()
      for (const id of prev) { if (visible.has(id)) next.add(id); else mutated = true }
      return mutated ? next : prev
    })
  }, [rows])

  const toggle = useCallback((id) => {
    setSelectedIds((prev) => {
      const n = new Set(prev)
      const k = String(id)
      if (n.has(k)) n.delete(k); else n.add(k)
      return n
    })
  }, [])

  const clear = useCallback(() => setSelectedIds(new Set()), [])

  const toggleAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const ids = rows.map((r) => String(r.id))
      const all = ids.length > 0 && ids.every((id) => prev.has(id))
      return all ? new Set() : new Set(ids)
    })
  }, [rows])

  // Snapshot prior state so the undo (bulk-revert) restores exactly what changed.
  const snapshot = useCallback((ids) => ids.map((id) => {
    const row = rows.find((r) => String(r.id) === String(id))
    return {
      reply_id: Math.abs(Number(id)),
      source: sourceOf(id),
      prior_handled: row?.handled ?? false,
      prior_classification: row?.classification ?? null,
    }
  }), [rows])

  // Capped-concurrency per-row loop (mirrors runBulkLoop). Returns counts +
  // the failed rows so the error toast can list them.
  const runLoop = useCallback(async (ids, label, perRow) => {
    if (ids.length === 0) return { ok: 0, err: 0, failedRows: [] }
    setProgress({ done: 0, total: ids.length, label })
    let ok = 0, err = 0, done = 0
    const failedRows = []
    const queue = [...ids]
    const concurrency = Math.min(BULK_CONCURRENCY_CAP, queue.length)
    let inFlight = 0
    await new Promise((resolve) => {
      const pump = () => {
        while (inFlight < concurrency && queue.length > 0) {
          const id = queue.shift()
          inFlight++
          perRow(id)
            .then(() => { ok++ })
            .catch((e) => { err++; failedRows.push({ id, error: e?.message || String(e) }) })
            .finally(() => {
              inFlight--; done++
              setProgress({ done, total: ids.length, label })
              if (queue.length === 0 && inFlight === 0) { setProgress(null); resolve() }
              else pump()
            })
        }
      }
      pump()
    })
    return { ok, err, failedRows }
  }, [])

  const revert = useCallback(async (reverts) => {
    try {
      await mutate('/replies/bulk-revert', { method: 'POST', body: { reverts } })
      onChanged?.()
      toast?.('Vráceno zpět', 'ok')
    } catch (e) {
      toast?.(`Nepodařilo se vrátit: ${e?.message || 'neznámá chyba'}`, 'err')
    }
  }, [onChanged, toast])

  // Fail-open suppression pre-flight (mirrors v1). Returns false only if the
  // operator declines the confirm; a failed check never blocks the action.
  const passSuppressionGate = useCallback(async (ids) => {
    let suppressed = []
    try {
      const r = await mutate('/replies/bulk-suppress-check', { method: 'POST', body: { ids: ids.map(Number) } })
      suppressed = r.suppressed || []
    } catch { suppressed = [] }
    if (suppressed.length > SUPPRESSION_WARN_THRESHOLD) {
      const n = new Set(suppressed.map((s) => s.id)).size
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(`${n} ${n === 1 ? 'odesílatel je' : 'odesílatelé jsou'} na seznamu omezení. Pokračovat?`)
        : true
      if (!ok) return false
    }
    return true
  }, [])

  const plural = (n, one, few, many) => (n === 1 ? one : n < 5 ? few : many)

  // Shared finisher: refresh, clear selection (when acting on the selection),
  // and surface success (with undo) / partial-failure (with retry) toasts.
  const finish = useCallback((result, snaps, { okMsg, clearAfter, retry }) => {
    const { ok, err, failedRows } = result
    onChanged?.()
    if (err === 0) {
      // Clear the selection ONLY on full success — on partial failure keep it so
      // the still-failing rows stay selected and visible to the operator.
      if (clearAfter) clear()
      toast?.(okMsg(ok), 'ok', {
        secondaryAction: { label: 'Zpět', onClick: () => revert(snaps) },
      })
    } else {
      // Retry ONLY the failed rows — re-POSTing the whole original set would
      // re-process the rows that already succeeded (e.g. duplicate CRM forwards).
      const failedIds = failedRows.map((f) => f.id)
      toast?.(`${ok} OK · ${err} ${err === 1 ? 'chyba' : 'chyb'}`, 'err', {
        groupId: 'bulk-ops',
        failureDetails: failedRows.map((f) => ({ id: f.id, error: f.error })),
        secondaryAction: { label: 'Zkusit znovu', onClick: () => retry(failedIds) },
      })
    }
  }, [onChanged, clear, toast, revert])

  // Core runners take EXPLICIT ids so the retry can re-run only the failed rows
  // (finish passes failedIds into the retry closure). The public callbacks below
  // bind them to the current selection.
  const runHandled = useCallback(async (ids) => {
    if (ids.length === 0) return
    if (!(await passSuppressionGate(ids))) return
    const snaps = snapshot(ids)
    const result = await runLoop(ids, 'Označuji jako vyřízené',
      (id) => mutate(`/replies/${id}`, { method: 'PATCH', body: { handled: true } }))
    finish(result, snaps, {
      clearAfter: true,
      retry: (failedIds) => runHandled(failedIds),
      okMsg: (ok) => `${ok} ${plural(ok, 'odpověď vyřízena', 'odpovědi vyřízeny', 'odpovědí vyřízeno')}`,
    })
  }, [passSuppressionGate, snapshot, runLoop, finish])
  const markHandled = useCallback(() => runHandled(Array.from(selectedIds)), [runHandled, selectedIds])

  const runHide = useCallback(async (ids) => {
    if (ids.length === 0) return
    if (!(await passSuppressionGate(ids))) return
    const snaps = snapshot(ids)
    const result = await runLoop(ids, 'Skrývám z přehledu',
      (id) => mutate(`/replies/${id}`, { method: 'PATCH', body: { handled: true } }))
    finish(result, snaps, {
      clearAfter: true,
      retry: (failedIds) => runHide(failedIds),
      okMsg: (ok) => `${ok} ${plural(ok, 'odpověď skryta', 'odpovědi skryty', 'odpovědí skryto')} z přehledu`,
    })
  }, [passSuppressionGate, snapshot, runLoop, finish])
  const hide = useCallback(() => runHide(Array.from(selectedIds)), [runHide, selectedIds])

  // Forward to CRM. `ids` is explicit so the page can call it for the bulk
  // selection OR for the single open reply (clearAfter=false then). Positive
  // ids hit the white-label /forward-to-crm endpoint; unmatched (neg) ids have
  // no CRM linkage, so they are just marked handled (matches verbatim).
  const forwardCrm = useCallback(async ({ ids, notes = '', crm_url = '', clearAfter = true }) => {
    if (!ids || ids.length === 0) return
    if (!(await passSuppressionGate(ids))) return
    const snaps = snapshot(ids)
    const payload = { notes: notes.trim(), crm_url: crm_url.trim() }
    const result = await runLoop(ids, 'Předávám do CRM',
      (id) => Number(id) > 0
        ? mutate(`/replies/${id}/forward-to-crm`, { method: 'POST', body: payload })
        : mutate(`/replies/${id}`, { method: 'PATCH', body: { handled: true } }))
    finish(result, snaps, {
      clearAfter,
      retry: (failedIds) => forwardCrm({ ids: failedIds, notes, crm_url, clearAfter }),
      okMsg: (ok) => `${ok} ${plural(ok, 'odpověď předána', 'odpovědi předány', 'odpovědí předáno')} do CRM`,
    })
  }, [passSuppressionGate, snapshot, runLoop, finish])

  // Derived selection state for the bar's master checkbox.
  const visibleIds = rows.map((r) => String(r.id))
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))
  const indeterminate = selectedIds.size > 0 && !allVisibleSelected

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    allVisibleSelected,
    indeterminate,
    progress,
    toggle,
    clear,
    toggleAllVisible,
    markHandled,
    hide,
    forwardCrm,
  }
}
