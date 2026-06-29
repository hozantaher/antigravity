import { describe, expect, it } from 'vitest';
import { BlockType, MAX_BODY_PREFIX_BYTES, detectBlock } from './block-detector.js';

const fill = (n: number, c: string): string => c.repeat(n);

interface Case {
  readonly name: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly want: BlockType;
}

const cases: readonly Case[] = [
  // ---- rate_limit ----
  {
    name: 'rate_limit/429 + Retry-After numeric',
    status: 429,
    headers: { 'Retry-After': '120' },
    body: '{"error":"too many requests"}',
    want: BlockType.RateLimit,
  },
  {
    name: 'rate_limit/429 without Retry-After',
    status: 429,
    headers: {},
    body: 'Too Many Requests',
    want: BlockType.RateLimit,
  },
  {
    name: 'rate_limit/503 with Retry-After (overload)',
    status: 503,
    headers: { 'Retry-After': '30' },
    body: '<h1>Service Unavailable</h1>',
    want: BlockType.RateLimit,
  },
  {
    name: 'rate_limit/200 body marker rate limit exceeded',
    status: 200,
    headers: { 'Content-Type': 'text/html' },
    body: '<html><body><h1>Rate limit exceeded</h1></body></html>',
    want: BlockType.RateLimit,
  },

  // ---- captcha ----
  {
    name: 'captcha/google_recaptcha widget',
    status: 200,
    headers: { 'Content-Type': 'text/html' },
    body: '<html><body><div class="g-recaptcha" data-sitekey="abc"></div></body></html>',
    want: BlockType.Captcha,
  },
  {
    name: 'captcha/hcaptcha widget',
    status: 200,
    headers: {},
    body: '<html><body><div class="h-captcha"></div></body></html>',
    want: BlockType.Captcha,
  },
  {
    name: 'captcha/cf-turnstile widget',
    status: 200,
    headers: {},
    body: '<html><body><div class="cf-turnstile" data-sitekey="0x4"></div></body></html>',
    want: BlockType.Captcha,
  },
  {
    name: 'captcha/form action with captcha keyword',
    status: 200,
    headers: {},
    body: '<form action="/check-captcha" method="post"><input name="answer"></form>',
    want: BlockType.Captcha,
  },

  // ---- cloudflare ----
  {
    name: 'cloudflare/cf-ray header + just a moment body',
    status: 200,
    headers: { 'cf-ray': '8a7e2b1d4c5e6f7g-PRG', 'Content-Type': 'text/html' },
    body: '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser before accessing site.</body></html>',
    want: BlockType.Cloudflare,
  },
  {
    name: 'cloudflare/403 with Server: cloudflare',
    status: 403,
    headers: { Server: 'cloudflare' },
    body: '<html><body>Sorry, you have been blocked</body></html>',
    want: BlockType.Cloudflare,
  },
  {
    name: 'cloudflare/cf-mitigated challenge header',
    status: 200,
    headers: { 'cf-mitigated': 'challenge' },
    body: '<html></html>',
    want: BlockType.Cloudflare,
  },
  {
    name: 'cloudflare/checking your browser body marker',
    status: 200,
    headers: { 'cf-ray': 'abc-PRG' },
    body: '<html><head></head><body>Checking your browser</body></html>',
    want: BlockType.Cloudflare,
  },

  // ---- forbidden ----
  {
    name: 'forbidden/plain 403 no cloudflare signature',
    status: 403,
    headers: { Server: 'nginx' },
    body: '<h1>403 Forbidden</h1>',
    want: BlockType.Forbidden,
  },
  {
    name: 'forbidden/401 unauthorized',
    status: 401,
    headers: {},
    body: '{"error":"unauthorized"}',
    want: BlockType.Forbidden,
  },
  {
    name: 'forbidden/access denied html',
    status: 403,
    headers: {},
    body: '<html><body>Access Denied</body></html>',
    want: BlockType.Forbidden,
  },

  // ---- none ----
  {
    name: 'none/200 valid HTML business profile',
    status: 200,
    headers: { 'Content-Type': 'text/html' },
    body: '<html><body><h1>Bagry Praha s.r.o.</h1><p>IČO: 12345678</p></body></html>',
    want: BlockType.None,
  },
  {
    name: 'none/200 valid JSON-LD',
    status: 200,
    headers: { 'Content-Type': 'text/html' },
    body: '<html><body><script type="application/ld+json">{"@type":"LocalBusiness","name":"Test"}</script></body></html>',
    want: BlockType.None,
  },
  {
    name: 'none/404 legitimate not found',
    status: 404,
    headers: {},
    body: 'Not Found',
    want: BlockType.None,
  },
  {
    name: 'none/410 gone',
    status: 410,
    headers: {},
    body: 'Gone',
    want: BlockType.None,
  },

  // ---- edge ----
  {
    name: 'edge/empty body 200',
    status: 200,
    headers: {},
    body: '',
    want: BlockType.None,
  },
  {
    name: 'edge/large body cloudflare in first 4kB',
    status: 200,
    headers: { 'cf-ray': 'abc-PRG', 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser${fill(8000, 'x')}</body></html>`,
    want: BlockType.Cloudflare,
  },
  {
    name: 'edge/marker beyond 4kB window is missed (false-negative preferred)',
    status: 200,
    headers: {},
    body: `${fill(5000, 'a')}<title>Just a moment...</title>`,
    want: BlockType.None,
  },
  {
    name: 'edge/200 with word captcha in legit copy is not false-positive',
    status: 200,
    headers: { 'Content-Type': 'text/html' },
    body: '<html><body><p>Děkujeme, Vaše objednávka byla přijata. Captcha nebyla potřeba.</p></body></html>',
    want: BlockType.None,
  },
  {
    name: 'edge/case-mixed cloudflare body marker',
    status: 200,
    headers: { 'cf-ray': 'x-PRG' },
    body: '<HTML><HEAD><TITLE>JUST A MOMENT...</TITLE></HEAD></HTML>',
    want: BlockType.Cloudflare,
  },
  {
    name: 'edge/header lookup is case-insensitive (CF-RAY)',
    status: 200,
    headers: { 'CF-RAY': 'x-PRG' },
    body: '<title>Just a moment...</title>',
    want: BlockType.Cloudflare,
  },
  {
    name: 'edge/200 OK ARES HTML maintenance page is not classified as block',
    status: 200,
    headers: { 'Content-Type': 'text/html' },
    body: '<html><body><h1>ARES — služba dočasně nedostupná</h1></body></html>',
    want: BlockType.None,
  },
  {
    name: 'edge/malformed html 403 still classifies as forbidden by status',
    status: 403,
    headers: {},
    body: '<<<<not-real-html>>>>',
    want: BlockType.Forbidden,
  },
];

describe('detectBlock', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(detectBlock(c.status, c.headers, c.body)).toBe(c.want);
    });
  }

  it('respects MAX_BODY_PREFIX_BYTES cap', () => {
    const buried = `${fill(MAX_BODY_PREFIX_BYTES + 10, 'z')}g-recaptcha`;
    expect(detectBlock(200, {}, buried)).toBe(BlockType.None);
  });

  it('handles undefined headers without throwing', () => {
    expect(detectBlock(200, undefined, '{}')).toBe(BlockType.None);
    expect(detectBlock(403, undefined, 'forbidden')).toBe(BlockType.Forbidden);
  });

  it('accepts a Headers instance (fetch API)', () => {
    const h = new Headers({ 'cf-ray': 'abc-PRG' });
    expect(detectBlock(200, h, '<title>Just a moment...</title>')).toBe(BlockType.Cloudflare);
  });

  it('exposes wire-stable string values for healing_log audit', () => {
    expect(BlockType.None).toBe('none');
    expect(BlockType.RateLimit).toBe('rate_limit');
    expect(BlockType.Captcha).toBe('captcha');
    expect(BlockType.Cloudflare).toBe('cloudflare');
    expect(BlockType.Forbidden).toBe('forbidden');
  });
});
