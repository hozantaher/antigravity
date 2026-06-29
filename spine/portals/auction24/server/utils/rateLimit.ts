import type { H3Event } from 'h3'

// In-memory fixed-window limiter (process-local Map). garaaage-main backs this with Redis;
// here it's best-effort: App Hosting may run several instances (apphosting.yaml maxInstances),
// so the limit is enforced per-instance, not fleet-wide — enough to curb casual e-mail spam /
// enumeration probing, but provision a shared store for a hard global cap. Counters self-expire
// on the next request.

export interface RateLimitOpts {
  bucket: string
  limit: number
  windowMs: number
  key?: string
}

interface Counter {
  count: number
  resetAt: number
}

const counters = new Map<string, Counter>()

const IP_V4 = /^(\d{1,3}\.){3}\d{1,3}$/
const IP_V6 = /^[0-9a-f:]+$/i
const isValidIp = (ip: string): boolean => IP_V4.test(ip) || IP_V6.test(ip)

// Number of trusted proxy hops in front of the app (express "trust proxy"
// semantics). Default 1: App Hosting/Cloud Run sits behind one Google LB that
// appends the real client IP. The leftmost XFF entries are attacker-controlled,
// so the client is `hops` from the end. Set RATE_LIMIT_TRUSTED_HOPS=0 on an
// untrusted deployment to ignore XFF and key off the socket peer only.
const trustedHops = (): number => {
  const n = Number(process.env.RATE_LIMIT_TRUSTED_HOPS)
  return Number.isInteger(n) && n >= 0 ? n : 1
}

export const ipFromEvent = (event: H3Event): string => {
  const socketIp = event.node.req.socket?.remoteAddress ?? 'unknown'
  const hops = trustedHops()
  if (hops === 0) return socketIp
  const fwd = event.node.req.headers['x-forwarded-for']
  const list = (typeof fwd === 'string' ? fwd.split(',') : Array.isArray(fwd) ? fwd : [])
    .map(s => s.trim())
    .filter(Boolean)
  const candidate = list[list.length - hops]
  if (candidate && isValidIp(candidate)) return candidate
  return socketIp
}

// Bound the Map under sustained traffic — drop expired counters opportunistically.
const prune = (now: number): void => {
  if (counters.size < 5000) return
  for (const [k, c] of counters) if (c.resetAt <= now) counters.delete(k)
}

export const enforceRateLimit = (event: H3Event, opts: RateLimitOpts): void => {
  const now = Date.now()
  const key = `${opts.bucket}:${opts.key ?? ipFromEvent(event)}`
  const existing = counters.get(key)

  if (!existing || existing.resetAt <= now) {
    prune(now)
    counters.set(key, { count: 1, resetAt: now + opts.windowMs })
    return
  }

  existing.count += 1
  if (existing.count > opts.limit) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    setResponseHeader(event, 'Retry-After', retryAfter)
    setResponseHeader(event, 'X-RateLimit-Limit', opts.limit)
    setResponseHeader(event, 'X-RateLimit-Remaining', 0)
    throw createError({ statusCode: 429, statusMessage: 'Too many requests', data: { retryAfter } })
  }
}
