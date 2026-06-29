import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * AS6 + AS8 documentation validation tests.
 * Ensures markdown files are well-formed and contain required sections.
 */

const DOCS_ROOT = path.resolve('./docs/playbooks')

describe('Sprint AS6 — mullvad-pool-expansion.md', () => {
  const as6Path = path.join(DOCS_ROOT, 'mullvad-pool-expansion.md')

  it('file exists', () => {
    expect(fs.existsSync(as6Path)).toBe(true)
  })

  it('contains valid markdown structure', () => {
    const content = fs.readFileSync(as6Path, 'utf8')
    expect(content).toContain('# Rozšíření Mullvad pool')
    expect(content).toContain('Krok 1:')
    expect(content).toContain('Krok 2:')
    expect(content).toContain('Krok 3:')
    expect(content).toContain('Krok 4:')
    expect(content).toContain('Krok 5:')
    expect(content).toContain('Krok 6:')
    expect(content).toContain('Krok 7:')
  })

  it('contains required sections', () => {
    const content = fs.readFileSync(as6Path, 'utf8')
    expect(content).toContain('## Požadavky')
    expect(content).toContain('## Troubleshooting')
  })

  it('contains code examples', () => {
    const content = fs.readFileSync(as6Path, 'utf8')
    expect(content).toMatch(/```json[\s\S]*?"label"[\s\S]*?```/)
    expect(content).toMatch(/```bash[\s\S]*?curl[\s\S]*?```/)
  })

  it('contains safety warnings', () => {
    const content = fs.readFileSync(as6Path, 'utf8')
    expect(content).toContain('**Pozor:**')
    expect(content).toContain('Nikdy necommituj')
  })
})

describe('Sprint AS8 — pool-sizing-guide.md', () => {
  const as8Path = path.join(DOCS_ROOT, 'pool-sizing-guide.md')

  it('file exists', () => {
    expect(fs.existsSync(as8Path)).toBe(true)
  })

  it('contains valid markdown structure', () => {
    const content = fs.readFileSync(as8Path, 'utf8')
    expect(content).toContain('# Pool Sizing Guide')
    expect(content).toContain('## Quick Reference')
  })

  it('contains reference table', () => {
    const content = fs.readFileSync(as8Path, 'utf8')
    expect(content).toContain('| Počet schránek | Pool size |')
    expect(content).toContain('| 1–3 | 4 |')
    expect(content).toMatch(/\d+.*mailboxů.*\d+.*pool/)
  })

  it('contains principle sections', () => {
    const content = fs.readFileSync(as8Path, 'utf8')
    expect(content).toContain('## Principy')
    expect(content).toContain('## Scaling Trajectory')
    expect(content).toContain('## Monitoring Checklist')
  })

  it('contains cost information', () => {
    const content = fs.readFileSync(as8Path, 'utf8')
    expect(content).toContain('€')
    expect(content).toContain('/měsíc')
  })

  it('contains references to related docs', () => {
    const content = fs.readFileSync(as8Path, 'utf8')
    expect(content).toContain('docs/playbooks/mullvad-pool-expansion.md')
    expect(content).toContain('docs/initiatives/2026-05-09-strict-1to1-endpoint-pin.md')
  })
})

describe('Documentation consistency', () => {
  it('both docs are present', () => {
    const as6Path = path.join(DOCS_ROOT, 'mullvad-pool-expansion.md')
    const as8Path = path.join(DOCS_ROOT, 'pool-sizing-guide.md')
    expect(fs.existsSync(as6Path)).toBe(true)
    expect(fs.existsSync(as8Path)).toBe(true)
  })

  it('AS6 references AS8', () => {
    const content = fs.readFileSync(path.join(DOCS_ROOT, 'mullvad-pool-expansion.md'), 'utf8')
    expect(content).toContain('pool-sizing-guide.md')
  })

  it('AS8 references AS6', () => {
    const content = fs.readFileSync(path.join(DOCS_ROOT, 'pool-sizing-guide.md'), 'utf8')
    expect(content).toContain('mullvad-pool-expansion.md')
  })

  it('no broken markdown links', () => {
    const as6 = fs.readFileSync(path.join(DOCS_ROOT, 'mullvad-pool-expansion.md'), 'utf8')
    const as8 = fs.readFileSync(path.join(DOCS_ROOT, 'pool-sizing-guide.md'), 'utf8')

    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g
    const links = [...as6.matchAll(linkPattern), ...as8.matchAll(linkPattern)]

    // Check for obviously broken patterns
    links.forEach(([_, text, href]) => {
      expect(href).not.toMatch(/undefined|null|\{\{/)
      expect(href).not.toBe('')
    })
  })
})
