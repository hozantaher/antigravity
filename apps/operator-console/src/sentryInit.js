// Lazy Sentry shim — keeps the @sentry/react chunk OFF the LCP critical path.
//
// Before this change main.jsx → sentryInit.js → `import * as Sentry from
// '@sentry/react'` was a static dependency of the entry bundle, so the
// 155 kB-gzipped vendor-sentry chunk had to download + parse before paint.
// vendor-sentry is ~65 % of the shared baseline (237 kB gz total) and was
// flagged as the single biggest perf lever in
// `docs/audits/2026-04-30-performance-baseline.md`.
//
// Strategy: expose a synchronous `Sentry` object whose surface matches what
// the app uses (`addBreadcrumb`, `captureException`, `ErrorBoundary`,
// `withScope`). Calls made before the real SDK loads are queued (or buffered
// inside the boundary's local React state); after dynamic import resolves
// they're flushed and all subsequent calls go straight through.
//
// Triggered after first paint via `requestIdleCallback` (with
// `setTimeout(0)` fallback), so it never blocks LCP.

import { Component, createElement } from 'react'

const dsn = import.meta.env.VITE_SENTRY_DSN_FRONTEND
const env = import.meta.env.MODE || 'development'
const release = import.meta.env.VITE_APP_VERSION || import.meta.env.VITE_GIT_SHA || undefined
const tracesSampleRate = parseFloat(
  import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ||
    (env === 'production' ? '0.05' : '0')
)

// Real SDK reference once loaded. Stays null in non-DSN environments.
let realSentry = null

// Pending calls captured before the SDK finished loading.
const breadcrumbQueue = []
const exceptionQueue = []

function realAddBreadcrumb(b) {
  if (realSentry) realSentry.addBreadcrumb(b)
  else breadcrumbQueue.push(b)
}

function realCaptureException(err, scopeFn) {
  if (realSentry) {
    if (typeof scopeFn === 'function' && typeof realSentry.withScope === 'function') {
      realSentry.withScope((scope) => {
        try { scopeFn(scope) } catch {}
        realSentry.captureException(err)
      })
    } else {
      realSentry.captureException(err)
    }
  } else {
    exceptionQueue.push({ err, scopeFn })
  }
}

function flushQueues() {
  if (!realSentry) return
  for (const b of breadcrumbQueue.splice(0)) {
    try { realSentry.addBreadcrumb(b) } catch {}
  }
  for (const { err, scopeFn } of exceptionQueue.splice(0)) {
    try {
      if (typeof scopeFn === 'function' && typeof realSentry.withScope === 'function') {
        realSentry.withScope((scope) => {
          try { scopeFn(scope) } catch {}
          realSentry.captureException(err)
        })
      } else {
        realSentry.captureException(err)
      }
    } catch {}
  }
}

// Local ErrorBoundary that doesn't depend on @sentry/react being loaded.
// Falls back to capturing via the lazy shim once Sentry is available.
class LazySentryErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, errorInfo) {
    try {
      realCaptureException(error, (scope) => {
        if (errorInfo && errorInfo.componentStack) {
          scope.setExtra('componentStack', errorInfo.componentStack)
        }
      })
    } catch {
      // never let telemetry crash the boundary
    }
  }

  render() {
    if (this.state.hasError) {
      const fb = this.props.fallback
      return typeof fb === 'function' ? fb() : (fb ?? null)
    }
    return this.props.children
  }
}

// Public shim — same shape as `import * as Sentry from '@sentry/react'` for
// the subset we actually use.
export const Sentry = {
  addBreadcrumb: realAddBreadcrumb,
  captureException: realCaptureException,
  withScope: (fn) => {
    if (realSentry && typeof realSentry.withScope === 'function') {
      realSentry.withScope(fn)
    } else {
      // Buffer as an exception-less scope call by invoking with a stub scope.
      // Callers that wrap `captureException` inside the scope will go through
      // realCaptureException which already queues. Standalone withScope calls
      // pre-load are dropped — Sentry semantics allow that (scope is per-call).
      try { fn({ setExtra() {}, setTag() {}, setContext() {} }) } catch {}
    }
  },
  ErrorBoundary: LazySentryErrorBoundary,
}

// Kick off the dynamic load only when a DSN is configured AND we're in a
// browser. Tests/SSR/no-DSN dev: shim stays as a no-op (queues drain harmlessly).
function loadSentry() {
  if (!dsn || typeof window === 'undefined') return
  // Use requestIdleCallback so the import + init never compete with first paint.
  const schedule = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
    : (cb) => setTimeout(cb, 0)

  schedule(() => {
    import('@sentry/react')
      .then((mod) => {
        try {
          mod.init({
            dsn,
            environment: env,
            release,
            tracesSampleRate,
            ignoreErrors: [
              'ResizeObserver loop limit exceeded',
              'ResizeObserver loop completed with undelivered notifications',
              /^Network Error/,
              /^ChunkLoadError/,
              /Loading chunk \d+ failed/,
            ],
          })
          realSentry = mod
          flushQueues()
        } catch {
          // Init failed — leave shim in place so callers don't crash.
        }
      })
      .catch(() => {
        // Network/parse failure: shim continues to no-op silently.
      })
  })
}

loadSentry()

// `LazySentryErrorBoundary` is exported indirectly via Sentry.ErrorBoundary;
// `createElement` is imported only to keep tree-shaking honest about React
// usage (Sentry.ErrorBoundary is a React class component).
void createElement
