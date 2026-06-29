import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { execSync } from 'child_process'
import { createRequire } from 'module'
import bcrypt from 'bcryptjs'
const require = createRequire(import.meta.url)
const pkg = require('./package.json')

// AW-F1 (2026-05-20): Vite dev-server side Basic Auth gate. The BFF has
// its own middleware (src/lib/dashboardAuth.js) — this plugin guards the
// HTML + JS bundle the browser pulls from Vite itself. Both honor the
// same env (DASHBOARD_AUTH_ENABLED + DASHBOARD_USER + DASHBOARD_PASS_HASH)
// so the operator only configures credentials in one place.
//
// Bypass paths cover Vite's own protocol routes (/@vite/, /@react-refresh,
// /@fs/, /@id/, /node_modules/) plus the dashboard's bypass surface
// (/health, /healthz, /__schema-check, /api/sentry/tunnel). HMR + dev
// inspector must keep working unauthenticated otherwise the dev loop
// breaks.
function basicAuthPlugin(env) {
  const REALM = 'Hozan Taher Dashboard'
  const BYPASS_PREFIXES = [
    '/@vite/',
    '/@react-refresh',
    '/@fs/',
    '/@id/',
    '/node_modules/',
  ]
  const BYPASS_EXACT = new Set([
    '/health',
    '/healthz',
    '/__schema-check',
    '/api/sentry/tunnel',
    '/sentry-tunnel',
  ])
  function shouldBypass(url) {
    if (typeof url !== 'string') return false
    const path = url.split('?')[0]
    if (BYPASS_EXACT.has(path)) return true
    for (const p of BYPASS_PREFIXES) if (path.startsWith(p)) return true
    return false
  }
  function parseBasic(headerValue) {
    if (typeof headerValue !== 'string') return null
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(headerValue)
    if (!m) return null
    let decoded
    try { decoded = Buffer.from(m[1], 'base64').toString('utf8') } catch { return null }
    const idx = decoded.indexOf(':')
    if (idx < 0) return null
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) }
  }
  return {
    name: 'dashboard-basic-auth',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Re-read env each request so flips during dev don't need restart.
        // Vite loadEnv populates process.env from .env via the caller; we
        // also tolerate values supplied directly via env arg above.
        const enabled = (process.env.DASHBOARD_AUTH_ENABLED || env.DASHBOARD_AUTH_ENABLED) === 'true'
        if (!enabled) return next()
        if (shouldBypass(req.url)) return next()
        const expectedUser = process.env.DASHBOARD_USER || env.DASHBOARD_USER
        const expectedHash = process.env.DASHBOARD_PASS_HASH || env.DASHBOARD_PASS_HASH
        if (!expectedUser || !expectedHash) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'dashboard_auth_misconfigured' }))
          return
        }
        const parsed = parseBasic(req.headers['authorization'])
        const fail = () => {
          res.statusCode = 401
          res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`)
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end('Unauthorized')
        }
        if (!parsed) return fail()
        if (parsed.user !== expectedUser) return fail()
        let ok = false
        try { ok = bcrypt.compareSync(parsed.pass, expectedHash) } catch { ok = false }
        if (!ok) return fail()
        return next()
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiKey = env.OUTREACH_API_KEY
  const sentryAuthToken = env.SENTRY_AUTH_TOKEN
  const sentryOrg = env.SENTRY_ORG
  const sentryProject = env.SENTRY_PROJECT_FRONTEND

  const plugins = [basicAuthPlugin(env), react()]
  // Upload source maps to Sentry only when auth token is configured
  if (sentryAuthToken && sentryOrg && sentryProject) {
    plugins.push(sentryVitePlugin({
      org: sentryOrg,
      project: sentryProject,
      authToken: sentryAuthToken,
      telemetry: false,
    }))
  }

  let gitSha = 'unknown'
  try { gitSha = execSync('git rev-parse --short HEAD').toString().trim() } catch {}

  return {
    plugins,
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
      'import.meta.env.VITE_GIT_SHA': JSON.stringify(gitSha),
    },
    server: {
      port: 18175,
      strictPort: true,
      proxy: {
        '/api': {
          // Per HARD rule v3 feedback_outreach_dashboard_local_only (T0,
          // updated 2026-05-14 Z4 tear-down): UI + BFF + crons run
          // lokálně. Default proxy → localhost BFF (`node server.js`).
          // Operator override via DEV_BFF_TARGET env if needed.
          target: env.DEV_BFF_TARGET || 'http://localhost:18001',
          changeOrigin: true,
          headers: apiKey ? { 'x-api-key': apiKey } : {},
        },
      },
    },
    build: {
      sourcemap: true,
      chunkSizeWarningLimit: 300,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            // Sentry first — its packages depend on react internals, and
            // without an explicit rule they fall through into vendor-react,
            // bloating the critical path by ~140KB gzip (P-2 fix).
            if (id.includes('@sentry') || id.includes('@sentry-internal')) {
              return 'vendor-sentry'
            }
            if (id.includes('react-router')) return 'vendor-router'
            if (id.includes('zustand')) return 'vendor-state'
            if (id.includes('/zod/')) return 'vendor-zod'
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/scheduler/')
            ) {
              return 'vendor-react'
            }
            return undefined
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      exclude: ['**/node_modules/**', 'e2e/**', '**/.stryker-tmp/**', '**/dist/**', '**/reports/**'],
      setupFiles: ['src/test/polyfill.js', 'src/test/setup.js'],
      environmentOptions: {
        jsdom: {
          url: 'http://localhost:18175',
        },
      },
      coverage: {
        provider: 'v8',
        thresholds: { lines: 80, functions: 80, branches: 75 },
        exclude: ['e2e/**', 'src/test/**', '*.config.*', 'src/main.jsx'],
      },
    },
  }
})
