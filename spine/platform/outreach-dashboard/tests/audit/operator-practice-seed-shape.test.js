// @linkage-allowed: discipline ratchet — checks OP1.1 fixtures + OP1.3 seed-replies shape
/**
 * OP1 — audit test for the operator-practice seed infrastructure.
 *
 * Goal: prevent silent regression where someone:
 *   - removes the placeholder marker (X-Lab-Source) so real audit can't tell
 *     placeholder fixtures from real anonymized ones
 *   - adds a fixture file outside the documented schema
 *   - changes seed-replies.mjs CLI flags so wrappers/runbooks break
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../../..')
const FIXTURES = join(REPO_ROOT, 'tests/fixtures/operator-replies')
const SEED_NODE = join(REPO_ROOT, 'scripts/operator-practice/seed-replies.mjs')
const SEED_BASH = join(REPO_ROOT, 'scripts/mail-lab/seed-replies.sh')
const PLACEHOLDERS = join(FIXTURES, '_placeholders')

describe('OP1.1 — fixture schema', () => {
  // 1. README exists.
  it('fixtures README exists', () => {
    expect(existsSync(join(FIXTURES, 'README.md'))).toBe(true)
  })

  // 2. README forbids fabricated samples.
  it('README enforces real-data-only rule', () => {
    const r = readFileSync(join(FIXTURES, 'README.md'), 'utf8')
    expect(r).toMatch(/feedback_no_fabricated_test_data/i)
    expect(r).toMatch(/never|nikdy|nepřidávat|don't add/i)
  })

  // 3. README documents the X-Lab-Source header.
  it('README documents X-Lab-Source header', () => {
    const r = readFileSync(join(FIXTURES, 'README.md'), 'utf8')
    expect(r).toMatch(/X-Lab-Source/)
    expect(r).toMatch(/placeholder-infrastructure-test/)
    expect(r).toMatch(/real-anonymized/)
  })

  // 4. All 6 category subdirs exist.
  it('all 6 category subdirs exist', () => {
    const cats = ['interested', 'not-interested', 'ooo', 'wrong-person', 'spam', 'ambiguous']
    for (const c of cats) {
      expect(statSync(join(FIXTURES, c)).isDirectory()).toBe(true)
    }
  })

  // 5. _placeholders/ has at least one fixture per category.
  it('_placeholders covers every category', () => {
    const seen = new Set()
    for (const f of readdirSync(PLACEHOLDERS)) {
      if (!f.endsWith('.eml')) continue
      const body = readFileSync(join(PLACEHOLDERS, f), 'utf8')
      const cat = (body.match(/^X-Lab-Category:\s*(\S+)/im) || [])[1]
      if (cat) seen.add(cat)
    }
    for (const c of ['interested', 'not-interested', 'ooo', 'wrong-person', 'spam', 'ambiguous']) {
      expect(seen).toContain(c)
    }
  })

  // 6. Every placeholder file carries the placeholder marker.
  it('every placeholder marks itself X-Lab-Source: placeholder-infrastructure-test', () => {
    for (const f of readdirSync(PLACEHOLDERS)) {
      if (!f.endsWith('.eml')) continue
      const body = readFileSync(join(PLACEHOLDERS, f), 'utf8')
      expect(body).toMatch(/X-Lab-Source:\s*placeholder-infrastructure-test/)
    }
  })

  // 7. Real category subdirs are EMPTY of .eml files (until real export
  // arrives). This is the "no fabricated data" gate.
  it('real category subdirs hold zero fixtures yet', () => {
    const cats = ['interested', 'not-interested', 'ooo', 'wrong-person', 'spam', 'ambiguous']
    for (const c of cats) {
      const dir = join(FIXTURES, c)
      const eml = readdirSync(dir).filter((f) => f.endsWith('.eml'))
      expect(eml.length, `${c}/ should be empty until real anonymized fixtures land`).toBe(0)
    }
  })

  // 8. No fixture mentions Faker / faker / fake-* (sanity grep).
  it('no fabrication keywords in fixtures', () => {
    function walk(dir) {
      const out = []
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) out.push(...walk(p))
        else if (f.endsWith('.eml')) out.push(p)
      }
      return out
    }
    for (const path of walk(FIXTURES)) {
      const body = readFileSync(path, 'utf8')
      expect(body, path).not.toMatch(/\bfaker\b/i)
    }
  })

  // 9. Every placeholder uses the @anon.lab domain in From:.
  it('placeholders use @anon.lab in From:', () => {
    for (const f of readdirSync(PLACEHOLDERS)) {
      if (!f.endsWith('.eml')) continue
      const body = readFileSync(join(PLACEHOLDERS, f), 'utf8')
      expect(body).toMatch(/^From:.*@anon\.lab/m)
    }
  })

  // 10. Every placeholder has Date + Message-ID + To + Subject (RFC822 minimum).
  it('placeholders have required RFC822 headers', () => {
    for (const f of readdirSync(PLACEHOLDERS)) {
      if (!f.endsWith('.eml')) continue
      const body = readFileSync(join(PLACEHOLDERS, f), 'utf8')
      expect(body, f).toMatch(/^From:/m)
      expect(body, f).toMatch(/^To:/m)
      expect(body, f).toMatch(/^Subject:/m)
      expect(body, f).toMatch(/^Date:/m)
      expect(body, f).toMatch(/^Message-ID:/m)
    }
  })
})

describe('OP1.3 — seed-replies tool shape', () => {
  const node = readFileSync(SEED_NODE, 'utf8')
  const bash = readFileSync(SEED_BASH, 'utf8')

  // 11. Both scripts exist and are executable.
  it('node + bash entrypoints exist + executable', () => {
    expect(existsSync(SEED_NODE)).toBe(true)
    expect(existsSync(SEED_BASH)).toBe(true)
    expect(statSync(SEED_NODE).mode & 0o111).toBeGreaterThan(0)
    expect(statSync(SEED_BASH).mode & 0o111).toBeGreaterThan(0)
  })

  // 12. Node script has zero npm deps (no `from 'somewhere'` except node:* + relative).
  it('node script uses node:* imports only (zero npm deps)', () => {
    const importLines = node.split('\n').filter((l) => /^\s*import\s/.test(l))
    for (const line of importLines) {
      const m = line.match(/from\s+['"]([^'"]+)['"]/)
      if (!m) continue
      const src = m[1]
      // Allowed: node:* builtins or relative paths
      const ok = src.startsWith('node:') || src.startsWith('.') || src.startsWith('/')
      expect(ok, `forbidden import: ${src}`).toBe(true)
    }
  })

  // 13. Node script supports --dry-run.
  it('node script supports --dry-run', () => {
    expect(node).toMatch(/--dry-run/)
    expect(node).toMatch(/dryRun:/)
  })

  // 14. Node script supports --source filter (placeholder | real-anonymized | all).
  it('node script supports --source filter', () => {
    expect(node).toMatch(/--source/)
    expect(node).toMatch(/'placeholder'/)
    expect(node).toMatch(/'real-anonymized'/)
  })

  // 15. Node script supports --category filter.
  it('node script supports --category filter', () => {
    expect(node).toMatch(/--category/)
  })

  // 16. Node script supports --count.
  it('node script supports --count', () => {
    expect(node).toMatch(/--count/)
  })

  // 17. Node script has bounded IMAP timeout (no hang-forever).
  it('IMAP read has bounded timeout', () => {
    expect(node).toMatch(/timeout/i)
    expect(node).toMatch(/Date\.now/)
  })

  // 18. Node script has distinct exit codes documented in header.
  it('exit codes documented (1 auth, 2 no fixtures, 3 missing arg, 4 APPEND rejected)', () => {
    expect(node).toMatch(/Exit codes/)
    expect(node).toMatch(/1\s+IMAP/)
    expect(node).toMatch(/2\s+no/)
    expect(node).toMatch(/3\s+missing/)
    expect(node).toMatch(/4\s+APPEND/)
  })

  // 19. Node script accepts insecure TLS (lab self-signed cert).
  it('lab TLS is rejectUnauthorized=false (lab self-signed)', () => {
    expect(node).toMatch(/rejectUnauthorized:\s*false/)
  })

  // 20. Bash wrapper requires count + mailbox.
  it('bash wrapper requires positional count + mailbox', () => {
    expect(bash).toMatch(/COUNT="\$1"/)
    expect(bash).toMatch(/MAILBOX="\$2"/)
    expect(bash).toMatch(/\$#\s*-lt\s*2/)
  })

  // 21. Bash wrapper honors LAB_IMAP_HOST + LAB_IMAP_PORT env overrides.
  it('bash wrapper exposes LAB_IMAP_HOST + LAB_IMAP_PORT', () => {
    expect(bash).toMatch(/LAB_IMAP_HOST/)
    expect(bash).toMatch(/LAB_IMAP_PORT/)
  })

  // 22. Bash wrapper has set -euo pipefail (discipline).
  it('bash wrapper uses set -euo pipefail', () => {
    expect(bash).toMatch(/set -euo pipefail/)
  })

  // 23. Node script exports IMAPClient + parseArgs for unit testing.
  it('node script exports IMAPClient + parseArgs', () => {
    expect(node).toMatch(/export\s*\{[^}]*IMAPClient/)
    expect(node).toMatch(/export\s*\{[^}]*parseArgs/)
  })
})

describe('OP1 — dry-run integration smoke', () => {
  // 24. parseArgs returns expected default object.
  it('parseArgs gives sane defaults', async () => {
    const { parseArgs } = await import(SEED_NODE)
    const args = parseArgs(['node', 'script', '--mailbox', 'a@x.lab'])
    expect(args.host).toBe('localhost')
    expect(args.port).toBe(25993)
    expect(args.tls).toBe(true)
    expect(args.count).toBe(10)
    expect(args.source).toBe('placeholder')
    expect(args.folder).toBe('INBOX')
    expect(args.dryRun).toBe(false)
  })

  // 25. parseArgs honors --dry-run + --count + --category.
  it('parseArgs honors all CLI flags', async () => {
    const { parseArgs } = await import(SEED_NODE)
    const args = parseArgs(['node', 'script',
      '--mailbox', 'a@x.lab',
      '--count', '25',
      '--category', 'interested',
      '--source', 'real-anonymized',
      '--dry-run',
    ])
    expect(args.count).toBe(25)
    expect(args.category).toBe('interested')
    expect(args.source).toBe('real-anonymized')
    expect(args.dryRun).toBe(true)
  })
})
