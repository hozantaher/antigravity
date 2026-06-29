/**
 * humanBehaviorSimulation.js — Pure helpers for AR10 + AR14 human-behaviour
 * simulation logic. No network, no DB, no side-effects — safe to unit-test.
 *
 * AR10: reply chain simulation (generic reply pool, draft generator, probability
 *       weights for per-message actions).
 * AR14: full INBOX scan + IMAP IDLE keep-alive + folder operations.
 */

// ── AR10: Generic reply pool ──────────────────────────────────────────────────
//
// Phrasings are chosen randomly from the pool so no fingerprint appears across
// accounts. Pool MUST have ≥ 20 entries (audit enforced in tests).
// HARD: no {{.template}} variables, no LLM call, no external API.

export const GENERIC_REPLY_POOL = [
  'Děkujeme za zprávu, momentálně bez zájmu.',
  'Děkuji za nabídku, prozatím nepotřebujeme.',
  'Díky za kontakt, v tuto chvíli to neřešíme.',
  'Vážíme si Vaší zprávy, ale aktuálně nemáme zájem.',
  'Zprávu obdržena, děkujeme. V tuto dobu není zájem.',
  'Dobrý den, prozatím bychom zájem neměli.',
  'Dobrý den, děkujeme za nabídku, ale teď ne.',
  'Díky za Váš email. Zatím to neřešíme, možná jindy.',
  'Přijato. Aktuálně to neřešíme, díky za pochopení.',
  'Dobrý den, zpráva přijata, v tuto chvíli bez zájmu.',
  'Velice děkujeme za zprávu, nyní však nemáme zájem.',
  'Díky, ale momentálně to pro nás není aktuální téma.',
  'Dobrý den, v tuto chvíli nemáme zájem, děkujeme.',
  'Za kontakt děkujeme. Prozatím to nepotřebujeme.',
  'Zprávu jsme obdrželi. Aktuálně nemáme zájem, díky.',
  'Dobrý den, vaše zpráva přijata. Bez zájmu nyní.',
  'Přečteno, díky. Tentokrát zájem nemáme.',
  'Dobrý den, moc děkujeme, ale zájem prozatím není.',
  'Přijato, díky. Momentálně to pro nás není relevantní.',
  'Děkujeme za Váš čas. Bez zájmu v tomto okamžiku.',
]

/**
 * Returns a random phrasing from the generic reply pool.
 * Uses Math.random() by default; pass a custom rng for deterministic tests.
 *
 * @param {() => number} [rng=Math.random] - random number generator in [0,1)
 * @returns {string}
 */
export function pickGenericReply(rng = Math.random) {
  const idx = Math.floor(rng() * GENERIC_REPLY_POOL.length)
  return GENERIC_REPLY_POOL[idx]
}

// ── AR10: Draft body generator ────────────────────────────────────────────────
//
// Generates a short, never-sent draft body. Text must:
//   - be short (20–120 chars)
//   - vary between calls (uses random seeds)
//   - NEVER be sent as an outbound email
//
// Drafts simulate "I started composing something" human behaviour without
// any real content leaking to the SMTP path.

const DRAFT_FRAGMENTS_A = [
  'Dobrý den,', 'Ahoj,', 'Vážený pane,', 'Zdravím,', 'Dobrý den tým,',
]
const DRAFT_FRAGMENTS_B = [
  'rád bych se ptal ohledně',
  'měl jsem otázku k',
  'potřeboval bych upřesnit',
  'chci se zeptat na',
  'chtěl jsem zmínit',
]
const DRAFT_FRAGMENTS_C = [
  'dodacích podmínek.',
  'aktuální nabídky.',
  'dostupnosti zboží.',
  'termínů dodání.',
  'technických detailů.',
  'ceníku.',
]

/**
 * Generates a short draft body text that simulates an unsent email.
 * Output varies per call based on rng.
 *
 * @param {() => number} [rng=Math.random]
 * @returns {string}  20–120 chars
 */
export function generateDraftBody(rng = Math.random) {
  const a = DRAFT_FRAGMENTS_A[Math.floor(rng() * DRAFT_FRAGMENTS_A.length)]
  const b = DRAFT_FRAGMENTS_B[Math.floor(rng() * DRAFT_FRAGMENTS_B.length)]
  const c = DRAFT_FRAGMENTS_C[Math.floor(rng() * DRAFT_FRAGMENTS_C.length)]
  return `${a} ${b} ${c}`
}

// ── AR10: Per-message action probabilities ────────────────────────────────────
//
// Given a random sample in [0, 1), returns the action to take on one
// UNSEEN message. Probabilities must match spec:
//
//   [0.00, 0.60) → mark_read   (60%)
//   [0.60, 0.70) → reply       (10%)
//   [0.70, 0.90) → archive     (20%)
//   [0.90, 0.95) → draft       (5%)
//   [0.95, 1.00) → noop        (5%)
//
// Keeping this as a pure function makes the probability distribution
// trivially testable via 1000-sample frequency analysis.

/**
 * @param {number} r - random sample in [0, 1)
 * @returns {'mark_read'|'reply'|'archive'|'draft'|'noop'}
 */
export function sampleMessageAction(r) {
  if (r < 0.60) return 'mark_read'
  if (r < 0.70) return 'reply'
  if (r < 0.90) return 'archive'
  if (r < 0.95) return 'draft'
  return 'noop'
}

// ── AR10: Mailbox sampling ────────────────────────────────────────────────────

/**
 * Returns true if this mailbox should be processed in the current cycle.
 * 30% of mailboxes are selected per-cycle to avoid uniform all-at-once pattern.
 *
 * @param {number} r - random sample in [0, 1)
 * @returns {boolean}
 */
export function shouldProcessMailbox(r) {
  return r < 0.30
}

// ── AR14: IMAP IDLE keep-alive window ────────────────────────────────────────
//
// For a given current hour (0–23) and a per-mailbox random offset (0..1),
// determines whether the mailbox should be in IDLE state right now.
//
// Window: 22:00–06:00 local time (8h window), each mailbox picks a random
// 2-hour block within that window.
//
// Block start selection: offset * 6 gives start offset (0–5) hours into the
// 22:00 window, so blocks span 22:00..23:59, 23:00..00:59, 00:00..01:59,
// 01:00..02:59, 02:00..03:59, 03:00..04:59.

/**
 * @param {number} hourUtc - current UTC hour 0–23
 * @param {number} mailboxOffset - stable per-mailbox float [0,1)
 * @returns {boolean}
 */
export function isInIdleWindow(hourUtc, mailboxOffset) {
  // Normalise hour into CET/CEST-approximate: UTC+1 in CET, UTC+2 in CEST.
  // For simplicity, use UTC+1 always (conservative — avoids SMTP window overlap).
  const localHour = (hourUtc + 1) % 24

  // IDLE window: 22:00–06:00 local = 8 hours. Use 6 blocks of 2h.
  const blockStart = 22 + Math.floor(mailboxOffset * 6) // 22,23,0,1,2,3
  const bs = blockStart % 24
  const be = (bs + 2) % 24

  // Check if localHour is in [bs, be)
  if (bs < be) {
    return localHour >= bs && localHour < be
  }
  // Wraps midnight: e.g. bs=23, be=1 → 23 or 0
  return localHour >= bs || localHour < be
}

// ── AR14: Folder CREATE guard (idempotent) ───────────────────────────────────

/** Folders that should always exist on a healthy Seznam mailbox. */
export const REQUIRED_FOLDERS = ['Drafts', 'Sent', 'Trash', 'Archive', 'Spam']

/**
 * Given a LIST of folders reported by the server, returns which required
 * folders are missing (need CREATE).
 *
 * @param {string[]} existingFolders - case-insensitive folder names from IMAP LIST
 * @param {string[]} [required=REQUIRED_FOLDERS]
 * @returns {string[]}  folders to CREATE
 */
export function missingFolders(existingFolders, required = REQUIRED_FOLDERS) {
  const lower = new Set(existingFolders.map(f => f.toLowerCase()))
  return required.filter(r => !lower.has(r.toLowerCase()))
}

// ── AR14: UID range for full inbox scan ──────────────────────────────────────

/**
 * Returns an IMAP UID range string for messages received in the last N days.
 * Uses IMAP SEARCH SINCE date format (e.g. "01-May-2026").
 *
 * @param {Date} now
 * @param {number} [days=7]
 * @returns {string}  e.g. "01-May-2026"
 */
export function imapSinceDate(now, days = 7) {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${dd}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}
