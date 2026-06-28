export function createErrorMiddleware() {
  // eslint-disable-next-line no-unused-vars
  return function errorMiddleware(err, req, res, next) {
    const status = (typeof err === 'object' && (err?.status || err?.statusCode)) || 500
    const safe4xx = status >= 400 && status < 500
    const message = safe4xx && err?.message ? err.message : 'internal server error'
    return res.status(status).json({ error: message })
  }
}
