// Minimal observability shim — garaaage-main wires Sentry here; garaaage-auction
// just logs so the email/auth ports can keep the same call sites.

export interface CaptureContext {
  area: string
  tags?: Record<string, string>
}

export const captureServerError = (err: unknown, ctx: CaptureContext): void => {
  console.error(`[${ctx.area}]`, err, ctx.tags ?? '')
}

export const addServerBreadcrumb = (message: string, data?: Record<string, unknown>): void => {
  if (process.env.NODE_ENV !== 'production') console.debug('[breadcrumb]', message, data ?? '')
}
