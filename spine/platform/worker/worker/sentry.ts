import * as Sentry from '@sentry/node'

const dsn = process.env.SENTRY_DSN_WORKER
const env = process.env.NODE_ENV || 'development'

if (dsn) {
  Sentry.init({
    dsn,
    environment: env,
    tracesSampleRate: 0,
  })

  process.on('unhandledRejection', (reason) => {
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)))
  })
  process.on('uncaughtException', (err) => {
    Sentry.captureException(err)
    Sentry.flush(2000).then(() => process.exit(1))
  })
}

export { Sentry }
