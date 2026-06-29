import { loadLiveItems } from '~/server/repos/itemRepo'

// Slim, public, cacheable auction state for the live layer. Polled by useLiveItems for the detail
// page (one id) and grids (the visible live cards). A short shared cache collapses N viewers of
// the same id-set into ~one DB read per window, so Postgres load stays flat as viewers grow.
// Anonymous by design (no per-user fields) — that's what makes it cacheable. Missing ids are
// omitted from the response; the client keys results by id.
const MAX_IDS = 50

const parseIds = (raw: unknown): string[] =>
  typeof raw === 'string'
    ? raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, MAX_IDS)
    : []

export default defineCachedEventHandler(event => loadLiveItems(parseIds(getQuery(event).ids)), {
  maxAge: 2,
  swr: true,
  // Normalize the key (trim/cap/order match the handler) so viewers of the same id-set share it.
  getKey: event => parseIds(getQuery(event).ids).join(','),
})
