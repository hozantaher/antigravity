import type { H3Event } from 'h3'
import { captureServerError } from './observability'

// Log the cause and surface a generic 502 — the shared failure boundary for the
// Firebase-admin / SendGrid calls behind the auth e-mail endpoints.
export const failEmailAction = (e: unknown, area: string, statusMessage: string): never => {
  captureServerError(e, { area })
  throw createError({ statusCode: 502, statusMessage })
}

// Firebase mints the oobCode on its hosted link; we drop its handler and point the
// e-mail at our own /auth/* page, which consumes the code via the client SDK.
export const buildOobActionUrl = (event: H3Event, firebaseLink: string, path: string): string => {
  const oobCode = new URL(firebaseLink).searchParams.get('oobCode')
  if (!oobCode) throw new Error(`${path}: Firebase action link has no oobCode`)
  // Fall back to the request origin when BASE_URL is unset (local dev / preview channels) so
  // the e-mailed link is always absolute — a relative href is unclickable in mail clients.
  const configured = String(useRuntimeConfig(event).public.baseUrl ?? '').replace(/\/$/, '')
  const baseUrl = configured || getRequestURL(event).origin
  return `${baseUrl}${path}?oobCode=${encodeURIComponent(oobCode)}`
}
