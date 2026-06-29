#!/usr/bin/env node
/**
 * seed-replies.mjs — IMAP APPEND fixtures into a Mail Lab inbox (OP1.3).
 *
 * Reads .eml files from tests/fixtures/operator-replies/<category>/ and
 * uploads each via raw IMAPS APPEND command. No npm deps — uses node's
 * built-in `tls` + `net` + `fs` only (matches services/orchestrator/imap
 * style: raw protocol, no third-party IMAP lib).
 *
 * Usage:
 *   node scripts/operator-practice/seed-replies.mjs \
 *     --mailbox op@gmail.lab \
 *     --password secret \
 *     --host localhost --port 25993 \
 *     [--count 10] \
 *     [--category interested] \
 *     [--source placeholder|real-anonymized|all] \
 *     [--mailbox-folder INBOX] \
 *     [--dry-run]
 *
 * Defaults:
 *   host=localhost, port=25993 (mail-lab-seznam IMAPS host port)
 *   count=10
 *   category=ALL (sample from every subdir)
 *   source=placeholder (until real anonymized fixtures exist)
 *   mailbox-folder=INBOX
 *
 * Exit codes:
 *   0 success
 *   1 IMAP connect/auth failure
 *   2 no matching fixtures found
 *   3 missing required argument
 *   4 APPEND command rejected
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect as tlsConnect } from 'node:tls'
import { connect as netConnect } from 'node:net'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '../..')
const FIXTURES_ROOT = join(REPO_ROOT, 'tests/fixtures/operator-replies')

// ── CLI parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    host: 'localhost',
    port: 25993,
    tls: true,
    mailbox: '',
    password: '',
    count: 10,
    category: 'ALL',
    source: 'placeholder',
    folder: 'INBOX',
    dryRun: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    switch (k) {
      case '--host': out.host = v; i++; break
      case '--port': out.port = parseInt(v, 10); i++; break
      case '--no-tls': out.tls = false; break
      case '--mailbox': out.mailbox = v; i++; break
      case '--password': out.password = v; i++; break
      case '--count': out.count = parseInt(v, 10); i++; break
      case '--category': out.category = v; i++; break
      case '--source': out.source = v; i++; break
      case '--mailbox-folder': out.folder = v; i++; break
      case '--dry-run': out.dryRun = true; break
      case '--help': case '-h': printHelp(); process.exit(0)
      default:
        if (k.startsWith('--')) {
          console.error(`unknown arg: ${k}`)
          process.exit(3)
        }
    }
  }
  return out
}

function printHelp() {
  console.log(`Usage: seed-replies.mjs --mailbox <addr> --password <pw> [opts]

Options:
  --host <h>          IMAPS host (default: localhost)
  --port <p>          IMAPS port (default: 25993)
  --no-tls            Plain IMAP (port 25143 etc.)
  --mailbox <addr>    Target inbox address (required)
  --password <pw>     Mailbox password (required)
  --count <n>         Number to inject (default: 10)
  --category <name>   interested | not-interested | ooo | wrong-person | spam | ambiguous | ALL
  --source <kind>     placeholder | real-anonymized | all (default: placeholder)
  --mailbox-folder    IMAP folder (default: INBOX)
  --dry-run           Print what would happen, don't connect

Exit codes: 0 OK / 1 auth / 2 no fixtures / 3 missing arg / 4 APPEND rejected`)
}

// ── Fixture discovery ────────────────────────────────────────────────

export function listFixtures(rootDir, { category, source }) {
  const subdirs = category === 'ALL'
    ? readdirSync(rootDir).filter((d) => {
      const p = join(rootDir, d)
      return statSync(p).isDirectory()
    })
    : [category]

  const out = []
  for (const sub of subdirs) {
    const dir = join(rootDir, sub)
    let entries
    try { entries = readdirSync(dir) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith('.eml')) continue
      const path = join(dir, f)
      const body = readFileSync(path, 'utf8')
      const xSource = (body.match(/^X-Lab-Source:\s*(\S+)/im) || [])[1] || 'unknown'
      const xCategory = (body.match(/^X-Lab-Category:\s*(\S+)/im) || [])[1] || sub
      // Source filter
      if (source !== 'all') {
        if (source === 'placeholder' && xSource !== 'placeholder-infrastructure-test') continue
        if (source === 'real-anonymized' && xSource !== 'real-anonymized') continue
      }
      out.push({ path, body, xSource, xCategory, name: basename(path) })
    }
  }
  return out
}

// ── Raw IMAP transport ───────────────────────────────────────────────

class IMAPClient {
  constructor({ host, port, tls, mailbox, password }) {
    this.host = host
    this.port = port
    this.useTls = tls
    this.mailbox = mailbox
    this.password = password
    this.sock = null
    this.buf = ''
    this.tag = 0
    this.lastResponse = ''
  }

  async connect() {
    this.sock = await new Promise((resolve, reject) => {
      const s = this.useTls
        ? tlsConnect({ host: this.host, port: this.port, rejectUnauthorized: false }, () => resolve(s))
        : netConnect({ host: this.host, port: this.port }, () => resolve(s))
      s.on('error', reject)
    })
    this.sock.setEncoding('utf8')
    this.sock.on('data', (chunk) => { this.buf += chunk })
    await this._readUntil('* OK')
  }

  async login() {
    return this._command(`LOGIN "${this.mailbox}" "${this.password}"`)
  }

  async appendRaw(folder, raw) {
    // APPEND <folder> {<size>}
    // <wait for "+">
    // <raw bytes>
    // <CRLF>
    // <wait for tagged OK>
    const tag = this._nextTag()
    const sizeBytes = Buffer.byteLength(raw, 'utf8')
    const cmd = `${tag} APPEND "${folder}" {${sizeBytes}}\r\n`
    this.sock.write(cmd)
    await this._readUntil('+')
    this.sock.write(raw)
    if (!raw.endsWith('\r\n')) this.sock.write('\r\n')
    return this._readUntil(`${tag} OK`)
  }

  async logout() {
    return this._command('LOGOUT')
  }

  close() { try { this.sock?.end() } catch {} }

  _nextTag() { this.tag++; return `A${String(this.tag).padStart(4, '0')}` }

  async _command(line) {
    const tag = this._nextTag()
    this.sock.write(`${tag} ${line}\r\n`)
    return this._readUntil(`${tag} OK`)
  }

  async _readUntil(needle, timeoutMs = 8000) {
    const start = Date.now()
    while (true) {
      if (this.buf.includes(needle)) {
        this.lastResponse = this.buf
        const idx = this.buf.indexOf(needle)
        const consumed = this.buf.slice(0, idx + needle.length)
        this.buf = this.buf.slice(idx + needle.length)
        return consumed
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`IMAP timeout waiting for "${needle}"; got: ${this.buf.slice(0, 200)}`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv)
  if (!args.mailbox && !args.dryRun) {
    console.error('--mailbox required')
    process.exit(3)
  }

  const fixtures = listFixtures(FIXTURES_ROOT, {
    category: args.category,
    source: args.source,
  })

  if (fixtures.length === 0) {
    console.error(`no fixtures matched category=${args.category} source=${args.source}`)
    process.exit(2)
  }

  // Sample N (without replacement until exhausted, then with replacement)
  const picked = []
  for (let i = 0; i < args.count; i++) {
    picked.push(fixtures[i % fixtures.length])
  }

  console.log(`seed-replies: would append ${picked.length} fixture(s) to ${args.mailbox}@${args.host}:${args.port}/${args.folder}`)
  for (const p of picked) {
    console.log(`  → ${p.xCategory}/${p.name} (source=${p.xSource})`)
  }
  if (args.dryRun) {
    console.log('--dry-run, exiting without network')
    return
  }

  if (!args.password) {
    console.error('--password required (when not --dry-run)')
    process.exit(3)
  }

  const client = new IMAPClient(args)
  try {
    await client.connect()
    await client.login()
    for (const p of picked) {
      try {
        await client.appendRaw(args.folder, p.body)
        console.log(`  ✓ ${p.name}`)
      } catch (e) {
        console.error(`  ✗ ${p.name}: ${e.message}`)
        process.exit(4)
      }
    }
    await client.logout()
  } catch (e) {
    console.error(`IMAP error: ${e.message}`)
    process.exit(1)
  } finally {
    client.close()
  }
  console.log(`seed-replies: done (${picked.length} appended)`)
}

// Allow library use without auto-running main
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}

export { parseArgs, IMAPClient }
