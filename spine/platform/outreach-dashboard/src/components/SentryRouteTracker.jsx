import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { Sentry } from '../sentryInit.js'

/**
 * Invisible component that emits a Sentry breadcrumb on every route change.
 * Must be rendered inside a <BrowserRouter> (or any React Router context).
 * Safe when Sentry is not initialized (no DSN configured).
 */
export default function SentryRouteTracker() {
  const location = useLocation()

  useEffect(() => {
    try {
      if (Sentry && typeof Sentry.addBreadcrumb === 'function') {
        Sentry.addBreadcrumb({
          category: 'navigation',
          message: location.pathname,
          level: 'info',
        })
      }
    } catch {
      // Never let Sentry instrumentation crash the app
    }
  }, [location.pathname])

  return null
}
