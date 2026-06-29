import { useCallback, useEffect, useRef, useState } from 'react'

// Offset-paginated accumulator for GET /api/replies.
//
// The BFF returns { rows, total } where `total` is a window COUNT(*) over the
// full reply_inbox + unmatched_inbound union (replies.js AS-F1), so we can stop
// paging the moment we've pulled everything. Pages accumulate; switching folder
// or search term (the `key`) resets to page 0. Rows are deduped by id so an
// overlapping page — e.g. a row shifted down by a concurrent insert between two
// fetches — never renders twice.
//
// This hook deliberately owns its own row state (rather than useResource) so the
// page can apply OPTIMISTIC mutations: patchRow flips flagged/handled the instant
// the operator acts, and the next refresh()/SSE reconciles against the server.
// useResource exposes no setData, hence the local store here.
//
// No magic numbers: REPLIES_PAGE_SIZE is the single source of the page size and
// the "is there a next page?" comparison (feedback_no_magic_thresholds).

export const REPLIES_PAGE_SIZE = 40

export function useInfiniteReplies(urlForOffset, { key, pageSize = REPLIES_PAGE_SIZE } = {}) {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(null)
  const [status, setStatus] = useState('idle') // idle | loading | loadingMore | ok | error
  const [error, setError] = useState(null)

  // urlForOffset is a fresh closure each render (it closes over mode/query); read
  // it through a ref so loadPage can stay referentially stable and the infinite
  // observer subscribes exactly once.
  const urlRef = useRef(urlForOffset)
  urlRef.current = urlForOffset
  const statusRef = useRef('idle')
  const offsetRef = useRef(0)
  const doneRef = useRef(false)
  const tokenRef = useRef(0)

  const setStatusBoth = (s) => { statusRef.current = s; setStatus(s) }

  const loadPage = useCallback(async (offset, replace) => {
    const myToken = ++tokenRef.current
    setStatusBoth(replace ? 'loading' : 'loadingMore')
    try {
      const res = await fetch(urlRef.current(offset))
      if (myToken !== tokenRef.current) return
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const data = await res.json()
      if (myToken !== tokenRef.current) return
      const page = Array.isArray(data?.rows) ? data.rows : []
      const tot = Number.isFinite(data?.total) ? data.total : null
      setTotal(tot)
      setRows((prev) => {
        const base = replace ? [] : prev
        const seen = new Set(base.map((r) => String(r.id)))
        return base.concat(page.filter((r) => !seen.has(String(r.id))))
      })
      offsetRef.current = offset + page.length
      doneRef.current = page.length < pageSize || (tot != null && offsetRef.current >= tot)
      setError(null)
      setStatusBoth('ok')
    } catch (e) {
      if (myToken !== tokenRef.current) return
      setError(e?.message || String(e))
      setStatusBoth('error')
    }
  }, [pageSize])

  // Reset + load page 0 whenever the query identity (folder + search) changes.
  // The cleanup bumps the token so a late page from the prior query is dropped.
  useEffect(() => {
    offsetRef.current = 0
    doneRef.current = false
    loadPage(0, true)
    return () => { tokenRef.current++ }
  }, [key, loadPage])

  const loadMore = useCallback(() => {
    if (doneRef.current) return
    if (statusRef.current === 'loading' || statusRef.current === 'loadingMore') return
    loadPage(offsetRef.current, false)
  }, [loadPage])

  const refresh = useCallback(() => {
    offsetRef.current = 0
    doneRef.current = false
    loadPage(0, true)
  }, [loadPage])

  // ── Optimistic mutators ──────────────────────────────────────────────────
  const patchRow = useCallback((id, patch) => {
    setRows((prev) => prev.map((r) => (String(r.id) === String(id) ? { ...r, ...patch } : r)))
  }, [])
  const removeRow = useCallback((id) => {
    setRows((prev) => prev.filter((r) => String(r.id) !== String(id)))
  }, [])
  const prependRow = useCallback((row) => {
    setRows((prev) => (prev.some((r) => String(r.id) === String(row.id)) ? prev : [row, ...prev]))
  }, [])

  return {
    rows, total, status, error,
    loadMore, refresh,
    patchRow, removeRow, prependRow,
    done: doneRef.current,
  }
}
