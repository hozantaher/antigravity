// sentinel-monitor.test.mjs
// Unit tests for scripts/sentinel-monitor.mjs.
//
// Safe import: the module guards isMain so Pool / argv validation never runs
// here. We test the pure check evaluators, formatting, redaction, kill-switch
// hint, and send-window arithmetic.

import { describe, it, expect, beforeAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// here = features/platform/outreach-dashboard/tests/unit/scripts
// → 5 levels up = repo root
const REPO_ROOT = join(here, '..', '..', '..', '..', '..', '..');
const MOD_PATH  = join(
  REPO_ROOT,
  'features', 'platform', 'outreach-dashboard', 'scripts', 'sentinel-monitor.mjs',
);

let THRESHOLDS, redactMailbox, isInSendWindow, evaluateChecks,
    formatAdvisory, maybeKillSwitchHint;

beforeAll(async () => {
  const mod = await import(MOD_PATH);
  THRESHOLDS         = mod.THRESHOLDS;
  redactMailbox      = mod.redactMailbox;
  isInSendWindow     = mod.isInSendWindow;
  evaluateChecks     = mod.evaluateChecks;
  formatAdvisory     = mod.formatAdvisory;
  maybeKillSwitchHint = mod.maybeKillSwitchHint;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a Date for a specific Prague clock hour on 2026-05-14. */
function pragueHour(hour) {
  // 2026-05-14 is CEST (UTC+2). Prague hour H → UTC hour H-2.
  const utcHour = (hour - 2 + 24) % 24;
  return new Date(Date.UTC(2026, 4, 14, utcHour, 30, 0)).getTime();
}

function makeData(overrides = {}) {
  return {
    sends_60m: 5,
    minutes_since_last_send: 4,
    mailboxes: [],
    new_replies_60m: 0,
    relay: { unreachable: false, queue_depth: 0 },
    ...overrides,
  };
}

// ── 1. redactMailbox ──────────────────────────────────────────────────────────

describe('redactMailbox', () => {
  it('masks last char of local part of a typical Seznam mailbox', () => {
    expect(redactMailbox('hozan.taher.71@post.cz')).toBe('hozan.taher.7X@post.cz');
  });

  it('keeps domain visible for operator', () => {
    const out = redactMailbox('contact@example.com');
    expect(out).toContain('@example.com');
    expect(out).not.toBe('contact@example.com');
  });

  it('returns short / malformed values as-is without crashing', () => {
    expect(redactMailbox('')).toBe('');
    expect(redactMailbox(null)).toBe('');
    expect(redactMailbox('a@b')).toBe('a@b');   // local too short — leave alone
    expect(redactMailbox('no-at-sign')).toBe('no-at-sign');
  });
});

// ── 2. isInSendWindow ─────────────────────────────────────────────────────────

describe('isInSendWindow (Prague timezone)', () => {
  it('returns false at 05:30 Prague', () => {
    expect(isInSendWindow(pragueHour(5))).toBe(false);
  });

  it('returns true at 09:30 Prague', () => {
    expect(isInSendWindow(pragueHour(9))).toBe(true);
  });

  it('returns true at 22:30 Prague (still inside window)', () => {
    expect(isInSendWindow(pragueHour(22))).toBe(true);
  });

  it('returns false at 23:30 Prague (after window close)', () => {
    expect(isInSendWindow(pragueHour(23))).toBe(false);
  });
});

// ── 3. evaluateChecks: alert paths ────────────────────────────────────────────

describe('evaluateChecks — red alerts', () => {
  it('raises send_rate_zero when no sends in window', () => {
    const advs = evaluateChecks(
      makeData({ sends_60m: 0 }),
      THRESHOLDS,
      pragueHour(10),
    );
    const codes = advs.map(a => a.code);
    expect(codes).toContain('send_rate_zero');
    expect(advs.find(a => a.code === 'send_rate_zero').level).toBe('alert');
  });

  it('does NOT raise send_rate_zero outside window', () => {
    const advs = evaluateChecks(
      makeData({ sends_60m: 0 }),
      THRESHOLDS,
      pragueHour(3),
    );
    expect(advs.map(a => a.code)).not.toContain('send_rate_zero');
  });

  it('raises mailbox_quarantine for auth_locked status', () => {
    const advs = evaluateChecks(
      makeData({
        mailboxes: [{ id: 1, from_address: 'hozan.taher.71@post.cz', status: 'auth_locked', sent_24h: 0, bounced_24h: 0 }],
      }),
      THRESHOLDS,
      pragueHour(10),
    );
    const a = advs.find(x => x.code === 'mailbox_quarantine');
    expect(a).toBeDefined();
    expect(a.level).toBe('alert');
    // PII redaction: full address must not appear verbatim
    expect(a.message).not.toContain('hozan.taher.71@post.cz');
    expect(a.message).toContain('hozan.taher.7X@post.cz');
  });

  it('raises mailbox_quarantine for bounce_hold status', () => {
    const advs = evaluateChecks(
      makeData({
        mailboxes: [{ id: 2, from_address: 'bar@example.cz', status: 'bounce_hold', sent_24h: 0, bounced_24h: 0 }],
      }),
      THRESHOLDS,
      pragueHour(10),
    );
    expect(advs.find(a => a.code === 'mailbox_quarantine')).toBeDefined();
  });
});

// ── 4. evaluateChecks: warn paths ─────────────────────────────────────────────

describe('evaluateChecks — yellow warns', () => {
  it('warns when mailbox bounce rate > 1.5 %', () => {
    const advs = evaluateChecks(
      makeData({
        mailboxes: [{
          id: 3, from_address: 'mb3@post.cz', status: 'active',
          sent_24h: 200, bounced_24h: 5, // 2.5 %
        }],
      }),
      THRESHOLDS,
      pragueHour(10),
    );
    const a = advs.find(x => x.code === 'bounce_rate_warn');
    expect(a).toBeDefined();
    expect(a.level).toBe('warn');
    expect(a.message).toMatch(/2\.50 %/);
  });

  it('skips bounce check when sample size < 10', () => {
    const advs = evaluateChecks(
      makeData({
        mailboxes: [{
          id: 4, from_address: 'mb4@post.cz', status: 'active',
          sent_24h: 5, bounced_24h: 2, // 40 %, but too few
        }],
      }),
      THRESHOLDS,
      pragueHour(10),
    );
    expect(advs.map(a => a.code)).not.toContain('bounce_rate_warn');
  });

  it('warns when sends have stalled > 30 min during window', () => {
    const advs = evaluateChecks(
      makeData({ minutes_since_last_send: 45 }),
      THRESHOLDS,
      pragueHour(10),
    );
    const a = advs.find(x => x.code === 'send_stalled');
    expect(a).toBeDefined();
    expect(a.level).toBe('warn');
  });

  it('warns on relay drain backlog > 100', () => {
    const advs = evaluateChecks(
      makeData({ relay: { unreachable: false, queue_depth: 150 } }),
      THRESHOLDS,
      pragueHour(10),
    );
    expect(advs.find(a => a.code === 'drain_backlog')).toBeDefined();
  });

  it('warns when relay is unreachable', () => {
    const advs = evaluateChecks(
      makeData({ relay: { unreachable: true, error: 'ECONNREFUSED' } }),
      THRESHOLDS,
      pragueHour(10),
    );
    expect(advs.find(a => a.code === 'relay_unreachable')).toBeDefined();
  });
});

// ── 5. evaluateChecks: info paths ─────────────────────────────────────────────

describe('evaluateChecks — info', () => {
  it('emits replies_new info-level when new replies seen', () => {
    const advs = evaluateChecks(
      makeData({ new_replies_60m: 3 }),
      THRESHOLDS,
      pragueHour(10),
    );
    const a = advs.find(x => x.code === 'replies_new');
    expect(a).toBeDefined();
    expect(a.level).toBe('info');
  });

  it('all-green path inside window produces no warn/alert advisories', () => {
    const advs = evaluateChecks(
      makeData({
        sends_60m: 12,
        minutes_since_last_send: 4,
        mailboxes: [{ id: 1, from_address: 'mb1@post.cz', status: 'active', sent_24h: 200, bounced_24h: 1 }],
      }),
      THRESHOLDS,
      pragueHour(10),
    );
    const reds = advs.filter(a => a.level === 'alert');
    const yels = advs.filter(a => a.level === 'warn');
    expect(reds).toHaveLength(0);
    expect(yels).toHaveLength(0);
  });
});

// ── 6. Formatting + kill-switch ───────────────────────────────────────────────

describe('formatAdvisory', () => {
  it('prefixes RED for alerts', () => {
    const line = formatAdvisory(
      { level: 'alert', code: 'x', message: 'něco' },
      '2026-05-14T10:00:00.000Z',
    );
    expect(line).toContain('[RED]');
    expect(line).toContain('něco');
  });

  it('prefixes YEL for warns and GRN for info', () => {
    expect(formatAdvisory({ level: 'warn', code: 'x', message: 'm' })).toContain('[YEL]');
    expect(formatAdvisory({ level: 'info', code: 'x', message: 'm' })).toContain('[GRN]');
  });

  it('includes the ISO timestamp', () => {
    const line = formatAdvisory(
      { level: 'info', code: 'x', message: 'm' },
      '2026-05-14T10:00:00.000Z',
    );
    expect(line).toContain('2026-05-14T10:00:00.000Z');
  });
});

describe('maybeKillSwitchHint', () => {
  it('returns null when consecutive red count below threshold', () => {
    expect(maybeKillSwitchHint(1, 457)).toBeNull();
  });

  it('emits psql snippet at threshold', () => {
    const hint = maybeKillSwitchHint(2, 457);
    expect(hint).toContain('UPDATE campaigns');
    expect(hint).toContain('WHERE id=457');
  });

  it('uses caller-provided campaignId in SQL', () => {
    const hint = maybeKillSwitchHint(3, 999);
    expect(hint).toContain('WHERE id=999');
  });
});
