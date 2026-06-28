import { create } from 'zustand'
import { Sentry } from './sentryInit'

// resilientLoad — bootstrap endpoints load in parallel; one failing
// endpoint must not blank the whole dashboard, so each falls back to a
// safe default. But the failure must NOT be swallowed silently: an empty
// mailbox list that's actually a fetch failure is indistinguishable from
// a genuinely empty account otherwise (quality-sweep "gaps" finding,
// 2026-05-30). We log + report to Sentry, then return the fallback.
function resilientLoad(label, promise, fallback) {
  return promise.catch(err => {
    console.error(`[store] bootstrap load failed: ${label}`, err)
    Sentry.addBreadcrumb({
      category: 'store.loadAll',
      level: 'warning',
      message: `${label} failed: ${err?.status ?? ''} ${err?.message ?? err}`.trim(),
    })
    return fallback
  })
}

// Throws an Error whose `.status` is the HTTP status and whose `.details`
// carries the parsed JSON body when the server returned a structured
// 4xx (e.g. 412 PRECONDITION_FAILED with blocker list). This lets
// callers (Campaigns.jsx setCampaignStatus toggle, etc.) render the
// specific reason instead of a generic "412 Precondition Failed".
const api = (path, opts) =>
  fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts }).then(async r => {
    if (!r.ok) {
      let details = null
      try { details = await r.json() } catch { /* non-JSON body */ }
      const err = new Error(`${r.status} ${r.statusText}`)
      err.status = r.status
      err.details = details
      throw err
    }
    return r.json()
  })

export default create((set, get) => ({
  mailboxes: [], campaigns: [], templates: [], segments: [], companies: [], totalCompanies: 0, replyStats: null, loading: false,

  loadAll: async () => {
    set({ loading: true })
    const [mailboxes, campaigns, templates, segments, stats, replyStats] = await Promise.all([
      resilientLoad('mailboxes', api('/mailboxes'), []),
      resilientLoad('campaigns', api('/campaigns'), []),
      resilientLoad('templates', api('/templates'), []),
      resilientLoad('segments', api('/segments'), []),
      resilientLoad('companies/stats', api('/companies/stats'), { total: 0 }),
      resilientLoad('replies/stats', api('/replies/stats'), null),
    ])
    set({ mailboxes, campaigns, templates, segments, totalCompanies: stats.total, replyStats, loading: false })
  },

  reloadReplyStats: async () => {
    const replyStats = await resilientLoad('replies/stats', api('/replies/stats'), null)
    set({ replyStats })
  },

  // Mailboxes
  // Accepts an optional search term. When present, the BFF filters by
  // from_address/display_name (parameterized ILIKE). Signature stays
  // backwards-compatible so existing `reloadMailboxes()` callers keep
  // working as a full-list refresh.
  reloadMailboxes: async (q) => {
    const qs = typeof q === 'string' && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''
    const mailboxes = await resilientLoad('mailboxes', api('/mailboxes' + qs), [])
    set({ mailboxes })
  },
  addMailbox: async (data) => {
    const mb = await api('/mailboxes', { method: 'POST', body: JSON.stringify(data) })
    set(s => ({ mailboxes: [mb, ...s.mailboxes] }))
  },
  updateMailbox: async (id, data) => {
    const mb = await api('/mailboxes/' + id, { method: 'PATCH', body: JSON.stringify(data) })
    set(s => ({ mailboxes: s.mailboxes.map(m => m.id === id ? { ...m, ...mb } : m) }))
    return mb
  },
  deleteMailbox: async (id) => {
    await api('/mailboxes/' + id, { method: 'DELETE' })
    set(s => ({ mailboxes: s.mailboxes.filter(m => m.id !== id) }))
  },

  // Campaigns
  addCampaign: async (data) => {
    const c = await api('/campaigns', { method: 'POST', body: JSON.stringify(data) })
    set(s => ({ campaigns: [c, ...s.campaigns] }))
    return c
  },
  setCampaignStatus: async (id, status) => {
    const c = await api('/campaigns/' + id, { method: 'PATCH', body: JSON.stringify({ status }) })
    set(s => ({ campaigns: s.campaigns.map(x => x.id === id ? { ...x, ...c } : x) }))
  },
  deleteCampaign: async (id) => {
    await api('/campaigns/' + id, { method: 'DELETE' })
    set(s => ({ campaigns: s.campaigns.filter(c => c.id !== id) }))
  },

  // Templates
  addTemplate: async (data) => {
    const t = await api('/templates', { method: 'POST', body: JSON.stringify(data) })
    set(s => ({ templates: [t, ...s.templates] }))
    return t
  },
  updateTemplate: async (id, data) => {
    const t = await api('/templates/' + id, { method: 'PUT', body: JSON.stringify(data) })
    set(s => ({ templates: s.templates.map(x => x.id === id ? { ...x, ...t } : x) }))
  },
  deleteTemplate: async (id) => {
    await api('/templates/' + id, { method: 'DELETE' })
    set(s => ({ templates: s.templates.filter(t => t.id !== id) }))
  },

  // Segments
  addSegment: async (data) => {
    const seg = await api('/segments', { method: 'POST', body: JSON.stringify(data) })
    set(s => ({ segments: [seg, ...s.segments] }))
    return seg
  },
  updateSegment: async (id, data) => {
    const seg = await api('/segments/' + id, { method: 'PATCH', body: JSON.stringify(data) })
    set(s => ({ segments: s.segments.map(x => x.id === id ? { ...x, ...seg } : x) }))
    return seg
  },
  rebuildSegment: async (id) => {
    const result = await api('/segments/' + id + '/rebuild', { method: 'POST' })
    if (result.segment) set(s => ({ segments: s.segments.map(x => x.id === id ? { ...x, ...result.segment } : x) }))
    return result
  },
  deleteSegment: async (id) => {
    await api('/segments/' + id, { method: 'DELETE' })
    set(s => ({ segments: s.segments.filter(x => x.id !== id) }))
  },
}))
