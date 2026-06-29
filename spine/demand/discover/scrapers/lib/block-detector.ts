/**
 * KT-A8 — semantic block detection for TS scrapers.
 *
 * Mirror of services/contacts/internal/blockdetect/detect.go. The two
 * detectors share signature catalogues so an upstream block looks the same
 * whether it comes through ARES (Go) or firmy.cz (TS) and the operator can
 * cross-correlate healing_log rows.
 *
 * Strategy:
 *  - Header-first detection (deterministic, low false-positive risk).
 *  - Body-second detection on the lower-cased first 4 kB.
 *  - Status fallback only for plain 401/403 with no other signature.
 *
 * Conservative by design: false negatives are preferred over false
 * positives. Missing a block degrades through KT-A7 health metrics on the
 * next iteration; misclassifying a valid response throws away real data.
 *
 * See docs/initiatives/2026-04-30-kt-a8-block-detection-design.md.
 */

/** Wire-stable string values: persisted to healing_log + slog tags. */
export const BlockType = {
  None: 'none',
  RateLimit: 'rate_limit',
  Captcha: 'captcha',
  Cloudflare: 'cloudflare',
  Forbidden: 'forbidden',
} as const;

export type BlockType = (typeof BlockType)[keyof typeof BlockType];

/** Largest slice of body inspected by detectBlock. */
export const MAX_BODY_PREFIX_BYTES = 4 * 1024;

const CAPTCHA_MARKERS = [
  'g-recaptcha',
  'h-captcha',
  'cf-turnstile',
  'action="/check-captcha"',
  'action="captcha"',
  'action="/captcha"',
] as const;

const CLOUDFLARE_MARKERS = [
  'just a moment...',
  'checking your browser',
  'cf-browser-verification',
  'cf-challenge-running',
] as const;

const RATE_LIMIT_BODY_MARKERS = ['rate limit exceeded', 'too many requests'] as const;

/**
 * Header bag accepted by detectBlock. Mirrors Node fetch / undici / express
 * shapes so callers don't need to normalise.
 */
export type HeaderBag = Headers | Record<string, string | string[] | undefined> | undefined;

/**
 * detectBlock returns the BlockType for a response, or BlockType.None when
 * no block signature is detected. The body argument may be either the raw
 * string (already-decoded HTML/JSON) or a Buffer; we only need the prefix.
 */
export function detectBlock(status: number, headers: HeaderBag, body: string | Buffer | undefined): BlockType {
  // 1) Header-first dispatch.
  const cfMitigated = readHeader(headers, 'cf-mitigated');
  if (cfMitigated && cfMitigated.length > 0) {
    return BlockType.Cloudflare;
  }
  if (status === 403 && headerEqualsLower(headers, 'server', 'cloudflare')) {
    return BlockType.Cloudflare;
  }
  if (status === 429) {
    return BlockType.RateLimit;
  }
  if (status === 503 && readHeader(headers, 'retry-after')) {
    return BlockType.RateLimit;
  }

  // 2) Body markers (lower-cased prefix).
  const prefix = bodyPrefix(body);
  if (prefix.length > 0) {
    const lower = prefix.toLowerCase();
    if (matchesAny(lower, CLOUDFLARE_MARKERS)) {
      return BlockType.Cloudflare;
    }
    if (matchesAny(lower, CAPTCHA_MARKERS)) {
      return BlockType.Captcha;
    }
    if (matchesAny(lower, RATE_LIMIT_BODY_MARKERS)) {
      return BlockType.RateLimit;
    }
  }

  // 3) Status fallback for naked 401/403.
  if (status === 401 || status === 403) {
    return BlockType.Forbidden;
  }
  return BlockType.None;
}

function bodyPrefix(body: string | Buffer | undefined): string {
  if (body === undefined || body === null) {
    return '';
  }
  if (typeof body === 'string') {
    return body.length > MAX_BODY_PREFIX_BYTES ? body.slice(0, MAX_BODY_PREFIX_BYTES) : body;
  }
  // Buffer path — slice then decode as utf-8 (best-effort; binary garbage
  // simply won't match any signature).
  const slice = body.length > MAX_BODY_PREFIX_BYTES ? body.subarray(0, MAX_BODY_PREFIX_BYTES) : body;
  return slice.toString('utf8');
}

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) return true;
  }
  return false;
}

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();

  if (headers instanceof Headers) {
    const v = headers.get(lower);
    return v ?? undefined;
  }

  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[0];
      return v ?? undefined;
    }
  }
  return undefined;
}

function headerEqualsLower(headers: HeaderBag, name: string, want: string): boolean {
  const v = readHeader(headers, name);
  return typeof v === 'string' && v.toLowerCase() === want.toLowerCase();
}
