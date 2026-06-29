// @hozan/dashboard-core — shared UI primitives (ADR-001)
// Re-exports the canonical implementations from apps/outreach-dashboard/.
// Phase: M6.1 (re-export barrels). Phase M6.2-B will move files physically.

export * from './lib/scoring.js'
export * from './lib/emailVerify.js'
export * from './lib/tokens.js'
export * from './lib/sentryCapture.js'
export * from './lib/fetchWithSentry.js'
export { RouteErrorBoundary } from './components/RouteErrorBoundary.jsx'
