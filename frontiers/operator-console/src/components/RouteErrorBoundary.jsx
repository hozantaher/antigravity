import { Sentry } from '../sentryInit.js'

export function RouteErrorBoundary({ children }) {
  return (
    <Sentry.ErrorBoundary
      fallback={
        <div style={{
          padding: '2rem',
          color: 'var(--red, var(--red))',
          fontSize: 'var(--text-sm, 0.875rem)',
        }}>
          Tato stránka selhala. <a href="/" style={{ color: 'inherit', textDecoration: 'underline' }}>Zpět na přehled</a>
        </div>
      }
    >
      {children}
    </Sentry.ErrorBoundary>
  )
}
