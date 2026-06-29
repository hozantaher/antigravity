import { beforeEach, vi } from 'vitest'
import { createError, defineEventHandler, isError, type H3Event } from 'h3'
import { parsePageParams } from '~/server/utils/pagination'
import { resolveRequestLocale } from '~/server/utils/requestLocale'

// Nitro handler unit-test harness. Nitro auto-imports h3 helpers and project server-utils as
// BARE identifiers; vitest imports handler modules raw (no unimport), so those identifiers resolve
// to globalThis. We install real h3 factories (defineEventHandler/createError so handlers build at
// import time and throw real H3Errors) plus lightweight accessors that read a plain mock event.
// The real h3 accessors require a full createEvent(req,res); a plain object is enough here.

type Any = Record<string, unknown>
const g = globalThis as Any

const header = (e: Any, name: string): string | undefined =>
  ((e.context as Any)?.headers as Any)?.[String(name).toLowerCase()] as string | undefined

Object.assign(g, {
  defineEventHandler,
  createError,
  isError,
  getRouterParam: (e: Any, name: string) => ((e.context as Any)?.params as Any)?.[name],
  getRouterParams: (e: Any) => (e.context as Any)?.params ?? {},
  getQuery: (e: Any) => (e.context as Any)?.query ?? {},
  getCookie: (e: Any, name: string) => ((e.context as Any)?.cookies as Any)?.[name],
  getHeader: header,
  getRequestHeader: header,
  setHeader: (e: Any, key: string, value: string) => {
    const ctx = e.context as Any
    ctx.resHeaders = { ...((ctx.resHeaders as Any) ?? {}), [key]: value }
  },
  readBody: async (e: Any) => (e.context as Any)?.body,
  readRawBody: async (e: Any) => {
    const body = (e.context as Any)?.body
    return body == null ? undefined : JSON.stringify(body)
  },
  getRequestURL: (e: Any) => new URL(((e.context as Any)?.url as string) ?? 'http://localhost/'),
  setResponseStatus: (e: Any, code: number) => {
    const res = (e.node as Any)?.res as Any
    if (res) res.statusCode = code
  },
  setResponseHeader: (e: Any, key: string, value: string) => {
    const ctx = e.context as Any
    ctx.resHeaders = { ...((ctx.resHeaders as Any) ?? {}), [key]: value }
  },
  // Caching is irrelevant to handler logic — unwrap to the raw handler.
  defineCachedEventHandler: (fn: unknown) => fn,
})

// Real pure project utils that handlers call as bare auto-imports — run them for real (they read
// the mock event's getQuery/getHeader installed above). Set once: they're stateless.
Object.assign(g, { parsePageParams, resolveRequestLocale })

// Project server-util auto-imports handlers call as bare identifiers. Reset to fresh vi.fn() before
// every test so a handler test configures them in isolation (e.g. requireSession.mockResolvedValue).
const authFns = ['requireSession', 'getSessionUser', 'requireAdmin', 'requireInteractiveAdmin', 'requireCronSecret']

const installProjectGlobals = () => {
  for (const name of authFns) g[name] = vi.fn()
  g.enforceRateLimit = vi.fn() // never throttle in unit tests
  g.captureServerError = vi.fn() // observability no-op
  g.addServerBreadcrumb = vi.fn()
  g.useRuntimeConfig = vi.fn(() => ({ public: {} }))
}

installProjectGlobals()
beforeEach(installProjectGlobals)

export interface MockEventInit {
  params?: Record<string, string>
  query?: Record<string, unknown>
  headers?: Record<string, string>
  cookies?: Record<string, string>
  body?: unknown
  url?: string
  method?: string
}

// Builds the minimal H3-event shape the accessors above read from.
export const makeEvent = (init: MockEventInit = {}) => {
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const url = init.url ?? 'http://localhost/'
  return {
    context: {
      params: init.params ?? {},
      query: init.query ?? {},
      headers,
      cookies: init.cookies ?? {},
      body: init.body,
      url,
    },
    node: { req: { method: init.method ?? 'POST', url, headers }, res: { statusCode: 200, setHeader() {} } },
  } as unknown as H3Event
}

// Configure the bare-global requireSession for a test (handlers that import it explicitly should
// vi.mock('~/server/utils/session') instead).
export const setSessionUser = (user: unknown) => {
  ;(g.requireSession as ReturnType<typeof vi.fn>).mockResolvedValue(user)
  ;(g.getSessionUser as ReturnType<typeof vi.fn>).mockResolvedValue(user)
}
