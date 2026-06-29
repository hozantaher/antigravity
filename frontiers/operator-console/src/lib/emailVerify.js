/**
 * Email verification — pure helpers (syntax, role/disposable/spamtrap patterns,
 * status classification). Network probes (MX, SMTP RCPT) live in emailProbe.js
 * to keep this module safe for browser bundling.
 *
 * Status enum (matches companies.email_status):
 *   unverified | valid | invalid | risky | catch_all | spamtrap | role_only | no_email
 */

export const EMAIL_STATUS = {
  UNVERIFIED: 'unverified',
  VALID:      'valid',
  INVALID:    'invalid',
  RISKY:      'risky',
  CATCH_ALL:  'catch_all',
  SPAMTRAP:   'spamtrap',
  ROLE_ONLY:  'role_only',
  NO_EMAIL:   'no_email',
}

export const STATUS_META = {
  unverified: { label: 'Neověřeno',  color: 'var(--muted)',  risk: 0 },
  valid:      { label: 'Platný',     color: 'var(--green)',  risk: 0 },
  invalid:    { label: 'Neplatný',   color: 'var(--red)',    risk: 3 },
  risky:      { label: 'Rizikový',   color: 'var(--yellow)', risk: 2 },
  catch_all:  { label: 'Catch-all',  color: 'var(--yellow)', risk: 2 },
  spamtrap:   { label: 'Spamtrap',   color: 'var(--red)',    risk: 3 },
  role_only:  { label: 'Role adresa',color: 'var(--yellow)', risk: 1 },
  no_email:   { label: 'Bez e-mailu',color: 'var(--muted)',  risk: 3 },
}

export function statusLabel(s)  { return STATUS_META[s]?.label ?? s ?? '—' }
export function statusColor(s)  { return STATUS_META[s]?.color ?? 'var(--muted)' }
function statusRisk(s)   { return STATUS_META[s]?.risk ?? 0 }

// ── Syntax ──────────────────────────────────────────────────────────
// RFC 5322 — simplified but catches the 99% of real issues. Accept:
//   local@domain.tld   where local ∈ [A-Za-z0-9._%+-]{1,64}
//                            domain ∈ [A-Za-z0-9-]+(.[A-Za-z0-9-]+)*.tld{2,}
export function validateSyntax(email) {
  if (!email || typeof email !== 'string') return { ok: false, reason: 'empty' }
  const trimmed = email.trim()
  if (trimmed.length > 254) return { ok: false, reason: 'too_long' }
  const at = trimmed.lastIndexOf('@')
  if (at < 1 || at === trimmed.length - 1) return { ok: false, reason: 'no_at' }
  const local  = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (local.length > 64) return { ok: false, reason: 'local_too_long' }
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..'))
    return { ok: false, reason: 'bad_local_dots' }
  if (!/^[A-Za-z0-9._%+\-]+$/.test(local))  return { ok: false, reason: 'local_chars' }
  if (!/^[A-Za-z0-9.\-]+$/.test(domain))    return { ok: false, reason: 'domain_chars' }
  if (!domain.includes('.'))                 return { ok: false, reason: 'no_tld' }
  const tld = domain.split('.').pop()
  if (!tld || tld.length < 2)                return { ok: false, reason: 'bad_tld' }
  return { ok: true, local, domain: domain.toLowerCase() }
}

// ── Free webmail providers ──────────────────────────────────────────
// Lower B2B priority — free address ≠ company-owned domain.
const FREE_WEBMAIL = new Set([
  'gmail.com','googlemail.com',
  'seznam.cz','post.cz','centrum.cz','atlas.cz','email.cz','volny.cz','tiscali.cz','quick.cz',
  'yahoo.com','yahoo.co.uk','ymail.com','rocketmail.com',
  'outlook.com','hotmail.com','live.com','msn.com',
  'icloud.com','me.com','mac.com',
  'protonmail.com','proton.me','pm.me',
  'aol.com','gmx.com','gmx.de','mail.com','zoho.com','tutanota.com','fastmail.com',
])
function isFreeWebmail(domain) {
  if (!domain) return false
  return FREE_WEBMAIL.has(domain.toLowerCase())
}

// ── Disposable domains ──────────────────────────────────────────────
const DISPOSABLE = new Set([
  'mailinator.com','guerrillamail.com','tempmail.com','10minutemail.com',
  'yopmail.com','throwawaymail.com','getnada.com','temp-mail.org',
  'dispostable.com','fakeinbox.com','mohmal.com','mytemp.email',
  'maildrop.cc','mailnesia.com','spambox.us','tmpmail.org',
  'trashmail.com','mailcatch.com','mintemail.com','trashmail.de',
  'sharklasers.com','grr.la','emailondeck.com','tempail.com',
])
export function isDisposable(domain) {
  if (!domain) return false
  return DISPOSABLE.has(domain.toLowerCase())
}

// ── Role addresses ──────────────────────────────────────────────────
const ROLE_DANGEROUS = new Set([
  'abuse','postmaster','noreply','no-reply','mailer-daemon','bounce',
  'spam','phishing','unsubscribe','devnull','null','void',
])
const ROLE_RISKY = new Set([
  'admin','administrator','security','support','help','billing','marketing',
  'sales','newsletter','test','demo','root','ops','info','contact','hello',
  'office','reception','webmaster','hostmaster','kontakt','obchod','podpora',
  'reklamace','fakturace',
])
export function roleCategory(localPart) {
  if (!localPart) return null
  const lp = localPart.toLowerCase()
  if (ROLE_DANGEROUS.has(lp)) return 'dangerous'
  if (ROLE_RISKY.has(lp))     return 'risky'
  return null
}

// ── Spamtrap heuristics ─────────────────────────────────────────────
const SPAMTRAP_DOMAINS = new Set([
  'spamcop.net','spamhaus.org','abuse.net','lashback.com',
  'example.com','example.org','test.com','localhost.com','invalid',
])
const SPAMTRAP_LOCAL_PATTERNS = [
  /spamtrap/i, /honeypot/i, /^trap-/i, /antispam/i, /-trap@/i,
]
export function isSpamtrap(email) {
  if (!email) return false
  const s = email.toLowerCase()
  const [local, domain] = s.split('@')
  if (!local || !domain) return false
  if (SPAMTRAP_DOMAINS.has(domain)) return true
  if (SPAMTRAP_LOCAL_PATTERNS.some(rx => rx.test(s))) return true
  // High-entropy random local part (typical list-wash spamtrap)
  if (local.length >= 12 && vowelRatio(local) < 0.15) return true
  return false
}
function vowelRatio(s) {
  const letters = s.replace(/[^a-z]/gi, '')
  if (!letters.length) return 1
  const vowels = letters.match(/[aeiouyAEIOUY]/g)?.length ?? 0
  return vowels / letters.length
}

// ── Status classification ───────────────────────────────────────────
/**
 * Given individual check results, return final email_status + human detail.
 *   input = {
 *     syntax_valid:  boolean,
 *     mx_exists:     boolean,
 *     smtp_valid:    boolean|null,   // null = not probed
 *     is_catch_all:  boolean|null,
 *     is_disposable: boolean,
 *     is_spamtrap:   boolean,
 *     is_role:       'dangerous'|'risky'|null,
 *   }
 */
export function classifyStatus(x) {
  if (!x.syntax_valid)                        return { status: EMAIL_STATUS.INVALID,   detail: 'Neplatný syntax' }
  if (x.is_spamtrap)                          return { status: EMAIL_STATUS.SPAMTRAP,  detail: 'Detekován spamtrap vzor' }
  if (x.is_disposable)                        return { status: EMAIL_STATUS.INVALID,   detail: 'Disposable doména' }
  if (!x.mx_exists)                           return { status: EMAIL_STATUS.INVALID,   detail: 'Doména nemá MX záznam' }
  if (x.is_role === 'dangerous')              return { status: EMAIL_STATUS.INVALID,   detail: `Role adresa: ${x.role || ''}`.trim() }
  if (x.smtp_valid === false)                 return { status: EMAIL_STATUS.INVALID,   detail: 'SMTP server odmítl příjemce' }
  if (x.is_catch_all === true)                return { status: EMAIL_STATUS.CATCH_ALL, detail: 'Doména přijímá všechny adresy' }
  if (x.is_role === 'risky')                  return { status: EMAIL_STATUS.ROLE_ONLY, detail: `Role adresa: ${x.role || ''}`.trim() }
  if (x.smtp_valid === true)                  return { status: EMAIL_STATUS.VALID,     detail: 'Ověřeno SMTP probe' }
  if (x.mx_exists && x.smtp_valid === null)   return { status: EMAIL_STATUS.RISKY,     detail: 'MX existuje, SMTP probe neproveden' }
  return { status: EMAIL_STATUS.UNVERIFIED, detail: '' }
}

// ── Confidence score 0–100 ──────────────────────────────────────────
/**
 * Composite 0–100 score. Higher = safer to send.
 * Weights:
 *   syntax_valid        +10 base
 *   mx_exists           +20
 *   smtp_valid===true   +30
 *   has_dmarc           +10
 *   has_spf             +10
 *   not is_role         +5  (risky -5, dangerous -30)
 *   not is_catch_all    +10
 *   not is_free_webmail +5  (B2B context)
 *   not is_disposable   already invalid → 0
 *   is_spamtrap         → 0
 */
export function computeConfidence(checks) {
  if (!checks?.syntax_valid) return 0
  if (checks.is_spamtrap)    return 0
  if (checks.is_disposable)  return 0
  let score = 10
  if (checks.mx_exists)            score += 20
  if (checks.smtp_valid === true)  score += 30
  else if (checks.smtp_valid === false) return Math.min(score, 15)
  if (checks.has_dmarc)            score += 10
  if (checks.has_spf)              score += 10
  if (checks.is_catch_all === true) score -= 15
  else if (checks.is_catch_all === false) score += 10
  if (checks.is_role === 'dangerous') return Math.min(score, 10)
  if (checks.is_role === 'risky')  score -= 8
  if (checks.is_free_webmail)      score -= 5
  return Math.max(0, Math.min(100, score))
}

export function confidenceColor(c) {
  if (c == null)     return 'var(--muted)'
  if (c >= 75)       return 'var(--green)'
  if (c >= 45)       return 'var(--yellow)'
  return 'var(--red)'
}

export function runPureChecks(email) {
  const syntax = validateSyntax(email)
  if (!syntax.ok) {
    return {
      email, syntax_valid: false, reason: syntax.reason,
      mx_exists: null, smtp_valid: null, is_catch_all: null,
      is_disposable: false, is_spamtrap: false, is_role: null,
    }
  }
  return {
    email,
    local:           syntax.local,
    domain:          syntax.domain,
    syntax_valid:    true,
    mx_exists:       null,
    smtp_valid:      null,
    is_catch_all:    null,
    is_disposable:   isDisposable(syntax.domain),
    is_spamtrap:     isSpamtrap(email),
    is_role:         roleCategory(syntax.local),
    is_free_webmail: isFreeWebmail(syntax.domain),
  }
}
