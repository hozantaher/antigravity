#!/usr/bin/env node
// set-dashboard-password.js — AW-F1 (2026-05-20)
//
// Interactive CLI helper to generate a bcrypt hash for the dashboard
// Basic Auth gate. Reads username + password from stdin (password
// without echo) and prints the .env snippet for the operator to paste
// into apps/outreach-dashboard/.env.
//
// Why not write .env directly: per feedback_no_pii_in_commands T0 and
// to avoid accidental overwrite of operator-managed env values. The
// operator pastes manually — they own the file.
//
// Usage:
//   node scripts/set-dashboard-password.js
//
// HARD rules:
//   - feedback_no_pii_in_commands T0 — password read from stdin only,
//     never logged, never echoed. The bcrypt hash is safe to print.
//   - feedback_no_magic_thresholds T0 — BCRYPT_COST_FACTOR named.

import { createInterface } from 'node:readline'
import { stdin, stdout, exit } from 'node:process'

// bcryptjs is installed under apps/outreach-dashboard. Resolve via the
// workspace so this script works from repo root.
let bcrypt
try {
  ;({ default: bcrypt } = await import('bcryptjs'))
} catch {
  try {
    ;({ default: bcrypt } = await import('../apps/outreach-dashboard/node_modules/bcryptjs/index.js'))
  } catch (e) {
    console.error('[set-dashboard-password] bcryptjs not installed.')
    console.error('Run `pnpm install` first (from apps/outreach-dashboard).')
    exit(2)
  }
}

const BCRYPT_COST_FACTOR = 12

function promptVisible(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// Reads a line from stdin without echoing characters. Falls back to
// visible prompt if not a TTY (e.g. CI piped input).
function promptHidden(question) {
  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      // Non-interactive — read raw line, accept the privacy tradeoff
      // (caller already chose to pipe; nothing we can do).
      return promptVisible(question).then(resolve)
    }
    stdout.write(question)
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let buf = ''
    const onData = (ch) => {
      // Ctrl-C
      if (ch === '') {
        cleanup()
        stdout.write('\n')
        exit(130)
      }
      // Enter / newline
      if (ch === '\r' || ch === '\n') {
        cleanup()
        stdout.write('\n')
        return resolve(buf)
      }
      // Backspace
      if (ch === '' || ch === '\b') {
        if (buf.length > 0) {
          buf = buf.slice(0, -1)
        }
        return
      }
      // Otherwise append
      buf += ch
    }
    function cleanup() {
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stdin.removeListener('data', onData)
    }
    stdin.on('data', onData)
  })
}

async function main() {
  console.log('Dashboard Basic Auth — credential generator (AW-F1)')
  console.log('---------------------------------------------------')
  console.log('This will hash a password with bcrypt cost factor ' + BCRYPT_COST_FACTOR + '.')
  console.log('Nothing is written to disk — paste the output into .env yourself.')
  console.log('')

  const user = await promptVisible('Username: ')
  if (!user) {
    console.error('[set-dashboard-password] username is required')
    exit(1)
  }

  const pass = await promptHidden('Password (input hidden): ')
  if (!pass || pass.length < 8) {
    console.error('[set-dashboard-password] password must be at least 8 characters')
    exit(1)
  }
  const confirm = await promptHidden('Confirm password: ')
  if (pass !== confirm) {
    console.error('[set-dashboard-password] passwords do not match')
    exit(1)
  }

  const hash = await bcrypt.hash(pass, BCRYPT_COST_FACTOR)

  console.log('')
  console.log('Paste these lines into apps/outreach-dashboard/.env:')
  console.log('---------------------------------------------------')
  console.log('DASHBOARD_AUTH_ENABLED=true')
  console.log(`DASHBOARD_USER=${user}`)
  console.log(`DASHBOARD_PASS_HASH=${hash}`)
  console.log('---------------------------------------------------')
  console.log('Then restart Vite (`pnpm dev`) and the BFF (`node server.js`).')
}

main().catch((e) => {
  console.error('[set-dashboard-password] unexpected error:', e?.message || e)
  exit(1)
})
