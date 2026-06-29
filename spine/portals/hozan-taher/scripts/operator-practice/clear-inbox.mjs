#!/usr/bin/env node
/**
 * clear-inbox.mjs — wipe a Mail Lab IMAP folder (OP2.4).
 *
 * Connects via raw IMAPS, runs SELECT INBOX, STORE +FLAGS \\Deleted on
 * every message, then EXPUNGE. Idempotent — empty inbox returns 0
 * without error.
 *
 * Usage:
 *   node clear-inbox.mjs --mailbox op@gmail.lab --password labpass
 *   node clear-inbox.mjs --self-test
 *
 * Exit codes:
 *   0 success
 *   1 IMAP connect/auth failure
 *   3 missing required arg
 */

import { connect as tlsConnect } from 'node:tls'
import { connect as netConnect } from 'node:net'

const HARD_CONFIRM = 'I-KNOW-THIS-WIPES-INBOX'

class IMAPSession {
  constructor({ host, port, tls, mailbox, password }) {
    this.host = host
    this.port = port
    this.useTls = tls
    this.mailbox = mailbox
    this.password = password
    this.sock = null
    this.buf = ''
    this.tag = 0
  }

  async connect() {
    this.sock = await new Promise((resolve, reject) => {
      const s = this.useTls
        ? tlsConnect({ host: this.host, port: this.port, rejectUnauthorized: false }, () => resolve(s))
        : netConnect({ host: this.host, port: this.port }, () => resolve(s))
      s.on('error', reject)
    })
    this.sock.setEncoding('utf8')
    this.sock.on('data', (c) => { this.buf += c })
    await this._readUntil('* OK')
  }

  async login() { return this._cmd(`LOGIN "${this.mailbox}" "${this.password}"`) }
  async select(folder) { return this._cmd(`SELECT "${folder}"`) }
  async storeAllDeleted() { return this._cmd('STORE 1:* +FLAGS (\\Deleted)') }
  async expunge() { return this._cmd('EXPUNGE') }
  async logout() { return this._cmd('LOGOUT') }

  close() { try { this.sock?.end() } catch {} }

  _nextTag() { this.tag++; return `A${String(this.tag).padStart(4, '0')}` }

  async _cmd(line) {
    const tag = this._nextTag()
    this.sock.write(`${tag} ${line}\r\n`)
    return this._readUntil(`${tag} OK`)
  }

  async _readUntil(needle, timeoutMs = 8000) {
    const start = Date.now()
    while (true) {
      if (this.buf.includes(needle)) {
        const idx = this.buf.indexOf(needle)
        const out = this.buf.slice(0, idx + needle.length)
        this.buf = this.buf.slice(idx + needle.length)
        return out
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`IMAP timeout waiting for "${needle}"`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

export function parseArgs(argv) {
  const out = {
    host: 'localhost', port: 25993, tls: true,
    mailbox: '', password: '',
    folder: 'INBOX',
    confirm: '',
    selfTest: false, help: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1]
    switch (k) {
      case '--host': out.host = v; i++; break
      case '--port': out.port = parseInt(v, 10); i++; break
      case '--no-tls': out.tls = false; break
      case '--mailbox': out.mailbox = v; i++; break
      case '--password': out.password = v; i++; break
      case '--folder': out.folder = v; i++; break
      case '--confirm': out.confirm = v; i++; break
      case '--self-test': out.selfTest = true; break
      case '--help': case '-h': out.help = true; break
    }
  }
  return out
}

function selfTest() {
  // Pure logic only — no network. Validates parseArgs + IMAPSession
  // command sequencing.
  const tests = [
    {
      name: 'parseArgs defaults',
      run: () => {
        const a = parseArgs(['node', 'x'])
        return a.folder === 'INBOX' && a.host === 'localhost' && a.tls === true
      },
    },
    {
      name: 'parseArgs honors --confirm',
      run: () => parseArgs(['node', 'x', '--confirm', 'YES']).confirm === 'YES',
    },
    {
      name: 'IMAPSession tag numbering',
      run: () => {
        const s = new IMAPSession({ host: 'x', port: 0, tls: false, mailbox: '', password: '' })
        return s._nextTag() === 'A0001' && s._nextTag() === 'A0002'
      },
    },
    {
      name: 'IMAPSession command formatting',
      run: () => {
        // Mock socket
        const writes = []
        const s = new IMAPSession({ host: 'x', port: 0, tls: false, mailbox: '', password: '' })
        s.sock = { write: (d) => writes.push(d) }
        s.buf = 'A0001 OK done\r\n'
        s.select('INBOX')
        return writes[0].includes('SELECT "INBOX"') && writes[0].startsWith('A0001 ')
      },
    },
  ]
  let pass = 0, fail = 0
  for (const t of tests) {
    try {
      if (t.run()) { console.log(`  ✓ ${t.name}`); pass++ }
      else { console.log(`  ✗ ${t.name}`); fail++ }
    } catch (e) {
      console.log(`  ✗ ${t.name} threw: ${e.message}`)
      fail++
    }
  }
  console.log(`\n${pass}/${pass + fail} pass`)
  return fail === 0
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log(`Usage: clear-inbox.mjs --mailbox X --password Y [--folder F] [--confirm '${HARD_CONFIRM}']

Wipes every message from a Mail Lab IMAP folder. Defaults: INBOX, IMAPS
on localhost:25993.

Required for non-self-test runs:
  --mailbox    target user
  --password   IMAP password
  --confirm    must equal '${HARD_CONFIRM}' (safety gate)

Optional:
  --folder F   default INBOX
  --host H     default localhost
  --port P     default 25993
  --no-tls     plain IMAP (port 25143)
  --self-test  run inline tests + exit
  --help       this message`)
    return
  }
  if (args.selfTest) { process.exit(selfTest() ? 0 : 4) }
  if (!args.mailbox || !args.password) {
    console.error('--mailbox + --password required')
    process.exit(3)
  }
  if (args.confirm !== HARD_CONFIRM) {
    console.error(`safety gate: pass --confirm '${HARD_CONFIRM}' to proceed`)
    process.exit(3)
  }
  const session = new IMAPSession(args)
  try {
    await session.connect()
    await session.login()
    await session.select(args.folder)
    await session.storeAllDeleted()
    await session.expunge()
    await session.logout()
    console.log(`clear-inbox: emptied ${args.folder} for ${args.mailbox}`)
  } catch (e) {
    console.error(`IMAP error: ${e.message}`)
    process.exit(1)
  } finally {
    session.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1) })
}

export { IMAPSession, HARD_CONFIRM }
