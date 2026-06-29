// Per-mailbox "last known-working proxy" memoization. assignBestProxy first
// tries the cached addr before fanning out smtpAuthProbe across the whole
// ranked pool — on happy path this cuts a 5× sequential probe down to 1.
//
// Cache is deliberately thin: one entry per mailbox, no per-(mailbox,proxy)
// pair tracking. The only question we need answered is "which proxy worked
// last time for this mailbox" — failures don't need caching because the probe
// loop is cheap on a small pool.
//
// Invalidation: TTL (30 min), smtpSendWithFallback network-error path, and
// implicit on probe failure inside assignBestProxy (cache entry was stale).

const TTL_MS = 30 * 60 * 1000
const MAX_ENTRIES = 500

const cache = new Map()

export function get(mailboxId) {
  const entry = cache.get(mailboxId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(mailboxId)
    return null
  }
  // LRU bump: re-insert at end so size-cap eviction drops truly-cold entries.
  cache.delete(mailboxId)
  cache.set(mailboxId, entry)
  return entry.addr
}

export function set(mailboxId, addr) {
  if (cache.has(mailboxId)) cache.delete(mailboxId)
  cache.set(mailboxId, { addr, expiresAt: Date.now() + TTL_MS })
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

export function invalidate(mailboxId) {
  cache.delete(mailboxId)
}

export function size() { return cache.size }
export function clear() { cache.clear() }

export const TTL = TTL_MS
export const MAX = MAX_ENTRIES
