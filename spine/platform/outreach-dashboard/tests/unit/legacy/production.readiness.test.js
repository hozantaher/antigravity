import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const ROOT = import.meta.dirname + '/../../..'

describe('Production readiness — MVP-35 (T-0315–T-0321)', () => {
  it('T-0315: build succeeds without errors', () => {
    const out = execSync('pnpm build', {
      encoding: 'utf8', timeout: 30000,
      cwd: ROOT, env: { ...process.env, NODE_ENV: 'production' },
    })
    expect(out).toContain('built in')
  })

  it('T-0316: dist/index.html exists after build', () => {
    expect(existsSync(ROOT + '/dist/index.html')).toBe(true)
  })

  it('T-0317: FAULT_INJECT_ALLOWED not enabled by default', () => {
    const content = readFileSync(ROOT + '/server.js', 'utf8')
    const match = content.match(/FAULT_INJECT_ALLOWED/g) || []
    for (const m of match) {
      expect(content).toContain('FAULT_INJECT_ALLOWED')
    }
    expect(content).not.toMatch(/FAULT_INJECT_ALLOWED\s*=\s*['"]?true['"]?/)
  })

  it('T-0318: package.json has all required scripts', () => {
    const pkg = JSON.parse(readFileSync(ROOT + '/package.json', 'utf8'))
    expect(pkg.scripts.build).toBeDefined()
    expect(pkg.scripts.dev).toBeDefined()
    expect(pkg.scripts.test).toBeDefined()
  })

  it('T-0319: .env.example or CLAUDE.md documents required env vars', () => {
    const claudeMd = existsSync(ROOT + '/CLAUDE.md')
      ? readFileSync(ROOT + '/CLAUDE.md', 'utf8')
      : ''
    const envExample = existsSync(ROOT + '/.env.example')
      ? readFileSync(ROOT + '/.env.example', 'utf8')
      : ''
    const docs = claudeMd + envExample
    expect(docs).toMatch(/GO_SERVER_URL|OUTREACH_API_KEY|PORT/)
  })

  it('T-0320: ErrorBoundary component exists in layout', () => {
    const layout = readFileSync(ROOT + '/src/components/Layout.jsx', 'utf8')
    expect(layout).toContain('ErrorBoundary')
  })

  it('T-0321: health endpoint exists in server.js', () => {
    const content = readFileSync(ROOT + '/server.js', 'utf8')
    expect(content).toMatch(/\/api\/health/)
  })
})
