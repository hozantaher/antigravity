// launch-monitor.test.mjs
// Unit tests for scripts/launch-monitor.mjs — evaluateHaltCriteria + redactEmail
// ≥10 test cases per extreme-testing memory rule.
// Safe import: module guards isMain so Pool/argv validation never runs here.

import { describe, it, expect, beforeAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// here = tests/unit/scripts  → 5 levels up = repo root
const REPO_ROOT = join(here, '..', '..', '..', '..', '..', '..');
const MOD_PATH  = join(REPO_ROOT, 'features', 'platform', 'outreach-dashboard', 'scripts', 'launch-monitor.mjs');

let evaluateHaltCriteria;
let redactEmail;
let THRESHOLDS;
let resetPollError;
let recordPollFailure;
let buildErrorSnapshot;
let renderError;
let getConsecutiveFailures;
let getLastSuccessAt;

beforeAll(async () => {
  const mod = await import(MOD_PATH);
  evaluateHaltCriteria = mod.evaluateHaltCriteria;
  redactEmail          = mod.redactEmail;
  THRESHOLDS           = mod.THRESHOLDS;
  resetPollError       = mod.resetPollError;
  recordPollFailure    = mod.recordPollFailure;
  buildErrorSnapshot   = mod.buildErrorSnapshot;
  renderError          = mod.renderError;
  // Access live module state via accessor helpers
  getConsecutiveFailures = () => mod.consecutiveFailures;
  getLastSuccessAt       = () => mod.lastSuccessAt;
});

// ── helpers for DB-error-state tests ─────────────────────────────────────────

/** Capture everything written to process.stdout during fn(). */
async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
    console.log = origLog;
  }
  return { stdout: chunks.join(''), logs };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeData(overrides = {}) {
  return {
    totalSent:         100,
    hardBounces:       0,
    totalReplies:      0,
    negativeReplies:   0,
    suppressionTotal:  50,
    mailboxes:         [],
    relay:             { unreachable: false, oldest_pending_age_seconds: 0 },
    ...overrides,
  };
}

function makeSnapshot(overrides = {}) {
  return {
    suppressionTotal: 50,
    snapshotAt: Date.now() - 60_000, // 1 minute ago
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TC-01: No halt when all metrics are healthy
// ══════════════════════════════════════════════════════════════════════════════
it('TC-01: returns empty halts array when all metrics are healthy', () => {
  const halts = evaluateHaltCriteria(makeData(), makeSnapshot());
  expect(halts).toEqual([]);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-02: Hard bounce rate > threshold triggers halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-02: triggers halt when hard bounce rate exceeds 5%', () => {
  // 6 hard bounces out of 100 sends = 6%
  const halts = evaluateHaltCriteria(
    makeData({ totalSent: 100, hardBounces: 6 }),
    makeSnapshot()
  );
  expect(halts.some(h => h.includes('HARD BOUNCE RATE'))).toBe(true);
  expect(halts[0]).toMatch(/6\.0%/);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-03: Hard bounce exactly at threshold is NOT a halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-03: hard bounce exactly at 5% does not trigger halt (boundary)', () => {
  const halts = evaluateHaltCriteria(
    makeData({ totalSent: 100, hardBounces: 5 }),
    makeSnapshot()
  );
  expect(halts.filter(h => h.includes('HARD BOUNCE RATE'))).toHaveLength(0);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-04: Negative reply rate > 20% AND n >= 5 triggers halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-04: triggers halt when negative reply rate >20% and n >= 5', () => {
  const halts = evaluateHaltCriteria(
    makeData({ totalReplies: 10, negativeReplies: 3 }), // 30%
    makeSnapshot()
  );
  expect(halts.some(h => h.includes('NEGATIVE REPLY RATE'))).toBe(true);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-05: Negative reply rate > 20% but n < 5 does NOT trigger halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-05: negative reply rate >20% with n<5 does NOT trigger halt (statistically insignificant)', () => {
  // 1 negative of 2 = 50% but n=2 < minN=5
  const halts = evaluateHaltCriteria(
    makeData({ totalReplies: 2, negativeReplies: 1 }),
    makeSnapshot()
  );
  expect(halts.filter(h => h.includes('NEGATIVE REPLY RATE'))).toHaveLength(0);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-06: Suppression growth rate > 10/min triggers halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-06: triggers halt when suppression growth exceeds 10/min', () => {
  // prev=50, now=200, elapsed=1 minute → 150/min >> 10/min
  const prev = { suppressionTotal: 50, snapshotAt: Date.now() - 60_000 };
  const halts = evaluateHaltCriteria(
    makeData({ suppressionTotal: 200 }),
    prev,
    Date.now()
  );
  expect(halts.some(h => h.includes('SUPPRESSION GROWTH'))).toBe(true);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-07: Suppression growth below threshold does NOT trigger halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-07: suppression growth below threshold does NOT trigger halt', () => {
  // prev=50, now=55, elapsed=1 minute → 5/min < 10/min
  const prev = { suppressionTotal: 50, snapshotAt: Date.now() - 60_000 };
  const halts = evaluateHaltCriteria(
    makeData({ suppressionTotal: 55 }),
    prev,
    Date.now()
  );
  expect(halts.filter(h => h.includes('SUPPRESSION GROWTH'))).toHaveLength(0);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-08: Mailbox circuit trip detected
// ══════════════════════════════════════════════════════════════════════════════
it('TC-08: detects mailbox circuit breaker trip', () => {
  const mailboxes = [{ id: 7, circuit_opened_at: '2026-05-06T07:00:00Z', last_score: 80, total_bounced: 3 }];
  const halts = evaluateHaltCriteria(makeData({ mailboxes }), makeSnapshot());
  expect(halts.some(h => h.includes('Mailbox 7 CIRCUIT TRIPPED'))).toBe(true);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-09: Mailbox low score detected
// ══════════════════════════════════════════════════════════════════════════════
it('TC-09: detects mailbox low score below threshold', () => {
  const mailboxes = [{ id: 3, circuit_opened_at: null, last_score: 42, total_bounced: 0 }];
  const halts = evaluateHaltCriteria(makeData({ mailboxes }), makeSnapshot());
  expect(halts.some(h => h.includes('Mailbox 3 LOW SCORE 42/100'))).toBe(true);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-10: Mailbox score exactly at threshold is NOT a halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-10: mailbox score exactly at threshold (60) does not trigger halt (boundary)', () => {
  const mailboxes = [{ id: 5, circuit_opened_at: null, last_score: 60, total_bounced: 0 }];
  const halts = evaluateHaltCriteria(makeData({ mailboxes }), makeSnapshot());
  expect(halts.filter(h => h.includes('LOW SCORE'))).toHaveLength(0);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-11: Relay unreachable triggers halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-11: relay unreachable triggers halt', () => {
  const relay = { unreachable: true, error: 'ECONNREFUSED' };
  const halts = evaluateHaltCriteria(makeData({ relay }), makeSnapshot());
  expect(halts.some(h => h.includes('RELAY UNREACHABLE'))).toBe(true);
  expect(halts.some(h => h.includes('ECONNREFUSED'))).toBe(true);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-12: Relay queue stuck triggers halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-12: relay queue oldest age > 600s triggers halt', () => {
  const relay = { unreachable: false, oldest_pending_age_seconds: 700, queue_depth: 12 };
  const halts = evaluateHaltCriteria(makeData({ relay }), makeSnapshot());
  expect(halts.some(h => h.includes('RELAY QUEUE STUCK'))).toBe(true);
  expect(halts.some(h => h.includes('700s'))).toBe(true);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-13: Relay queue exactly at threshold is NOT a halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-13: relay queue at exactly 600s does not trigger halt (boundary)', () => {
  const relay = { unreachable: false, oldest_pending_age_seconds: 600, queue_depth: 5 };
  const halts = evaluateHaltCriteria(makeData({ relay }), makeSnapshot());
  expect(halts.filter(h => h.includes('RELAY QUEUE STUCK'))).toHaveLength(0);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-14: PII redaction — redactEmail replaces smtp_username pattern
// ══════════════════════════════════════════════════════════════════════════════
it('TC-14: redactEmail replaces email addresses with mb<id>@… pattern', () => {
  const result = redactEmail('user@example.cz is the mailbox address', 3);
  expect(result).toBe('mb3@… is the mailbox address');
  expect(result).not.toContain('user@example.cz');
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-15: PII redaction — multiple occurrences all redacted
// ══════════════════════════════════════════════════════════════════════════════
it('TC-15: redactEmail replaces all occurrences in a string', () => {
  // Regex matches contiguous non-space tokens containing @, e.g. 'first@firma.cz'
  // and full tokens like 'from=first@firma.cz' — both are replaced.
  const result = redactEmail('first@firma.cz second@other.cz', 7);
  expect(result).toBe('mb7@… mb7@…');
  // No raw email pattern should survive
  expect(result).not.toMatch(/[a-zA-Z0-9]+@[a-zA-Z0-9]+\.[a-zA-Z]{2,}/);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-16: Threshold constants match expected values
// ══════════════════════════════════════════════════════════════════════════════
it('TC-16: exported THRESHOLDS match documented values', () => {
  expect(THRESHOLDS.hardBouncePct).toBe(5);
  expect(THRESHOLDS.negativeReplyPct).toBe(20);
  expect(THRESHOLDS.negativeReplyMinN).toBe(5);
  expect(THRESHOLDS.suppressionGrowthPerMin).toBe(10);
  expect(THRESHOLDS.relayQueueStuckSec).toBe(600);
  expect(THRESHOLDS.mailboxLowScore).toBe(60);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-17: Multiple simultaneous halt conditions all reported
// ══════════════════════════════════════════════════════════════════════════════
it('TC-17: reports all simultaneous halt conditions, not just the first', () => {
  const mailboxes = [
    { id: 1, circuit_opened_at: '2026-05-06T07:00:00Z', last_score: 80, total_bounced: 0 },
    { id: 2, circuit_opened_at: null, last_score: 30, total_bounced: 0 },
  ];
  const relay = { unreachable: true, error: 'timeout' };
  const data = makeData({
    totalSent: 100, hardBounces: 10,       // 10% > 5% → halt
    totalReplies: 10, negativeReplies: 3,  // 30% > 20%, n=10 >= 5 → halt
    mailboxes,
    relay,
  });
  const halts = evaluateHaltCriteria(data, makeSnapshot());
  expect(halts.filter(h => h.includes('HARD BOUNCE RATE'))).toHaveLength(1);
  expect(halts.filter(h => h.includes('NEGATIVE REPLY RATE'))).toHaveLength(1);
  expect(halts.filter(h => h.includes('CIRCUIT TRIPPED'))).toHaveLength(1);
  expect(halts.filter(h => h.includes('LOW SCORE'))).toHaveLength(1);
  expect(halts.filter(h => h.includes('RELAY UNREACHABLE'))).toHaveLength(1);
  expect(halts.length).toBeGreaterThanOrEqual(5);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-18: Null/undefined last_score does not trigger low-score halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-18: mailbox with null last_score does not trigger low-score halt', () => {
  const mailboxes = [{ id: 9, circuit_opened_at: null, last_score: null, total_bounced: 0 }];
  const halts = evaluateHaltCriteria(makeData({ mailboxes }), makeSnapshot());
  expect(halts.filter(h => h.includes('LOW SCORE'))).toHaveLength(0);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-19: Zero totalSent means 0% hard bounce rate — no halt
// ══════════════════════════════════════════════════════════════════════════════
it('TC-19: zero totalSent with non-zero hardBounces does not trigger halt (avoids /0)', () => {
  const halts = evaluateHaltCriteria(
    makeData({ totalSent: 0, hardBounces: 5 }),
    makeSnapshot()
  );
  expect(halts.filter(h => h.includes('HARD BOUNCE RATE'))).toHaveLength(0);
});

// ══════════════════════════════════════════════════════════════════════════════
// TC-20: Suppression snapshot with zero elapsed time does not produce infinite growth
// ══════════════════════════════════════════════════════════════════════════════
it('TC-20: zero elapsed time between snapshots does not produce Infinity/NaN growth halt', () => {
  const now = Date.now();
  const prev = { suppressionTotal: 50, snapshotAt: now }; // same millisecond
  const halts = evaluateHaltCriteria(
    makeData({ suppressionTotal: 9999 }),
    prev,
    now
  );
  // growthRate = delta/0 → guarded by `minutesElapsed > 0` check → growthRate = 0
  expect(halts.filter(h => h.includes('SUPPRESSION GROWTH'))).toHaveLength(0);
});

// ══════════════════════════════════════════════════════════════════════════════
// DB-error-state tests (Sprint — renderError / consecutiveFailures)
// ══════════════════════════════════════════════════════════════════════════════

describe('DB error state — consecutiveFailures tracking', () => {
  beforeEach(() => {
    resetPollError();
  });

  // TC-E01: consecutiveFailures increments on each recordPollFailure()
  it('TC-E01: consecutiveFailures increments on each recorded failure', () => {
    expect(getConsecutiveFailures()).toBe(0);
    recordPollFailure();
    expect(getConsecutiveFailures()).toBe(1);
    recordPollFailure();
    expect(getConsecutiveFailures()).toBe(2);
  });

  // TC-E02: resetPollError() resets counter to zero
  it('TC-E02: resetPollError resets consecutiveFailures to 0', () => {
    recordPollFailure();
    recordPollFailure();
    resetPollError();
    expect(getConsecutiveFailures()).toBe(0);
  });

  // TC-E03: buildErrorSnapshot captures current counter and lastSuccessAt
  it('TC-E03: buildErrorSnapshot captures consecutiveFailures and lastSuccessAt', () => {
    recordPollFailure();
    recordPollFailure();
    const err = new Error('ECONNREFUSED');
    const snap = buildErrorSnapshot(err);
    expect(snap.consecutiveFailures).toBe(2);
    expect(snap.error).toBe(err);
    expect(typeof snap.lastSuccessAt).toBe('number');
  });

  // TC-E04: buildErrorSnapshot error.message is preserved verbatim
  it('TC-E04: buildErrorSnapshot preserves error message verbatim', () => {
    const err = new Error('connection timeout after 5000ms');
    const snap = buildErrorSnapshot(err);
    expect(snap.error.message).toBe('connection timeout after 5000ms');
  });
});

describe('renderError — output content', () => {
  beforeEach(() => {
    resetPollError();
  });

  // TC-E05: renderError shows [!] DB UNREACHABLE banner
  it('TC-E05: renderError renders [!] DB UNREACHABLE banner', async () => {
    recordPollFailure();
    const snap = buildErrorSnapshot(new Error('ECONNREFUSED'));
    const { logs } = await captureStdout(() => renderError(snap, 30, true));
    const all = logs.join('\n');
    expect(all).toMatch(/\[!\] DB UNREACHABLE/);
  });

  // TC-E06: renderError shows consecutive failure count
  it('TC-E06: renderError shows consecutive failure count', async () => {
    recordPollFailure();
    recordPollFailure();
    recordPollFailure();
    const snap = buildErrorSnapshot(new Error('timeout'));
    const { logs } = await captureStdout(() => renderError(snap, 30, true));
    expect(logs.join('\n')).toMatch(/3/);
  });

  // TC-E07: renderError shows last successful poll time
  it('TC-E07: renderError shows lastSuccessAt as locale time string', async () => {
    const beforeReset = Date.now();
    resetPollError();
    recordPollFailure();
    const snap = buildErrorSnapshot(new Error('down'));
    const { logs } = await captureStdout(() => renderError(snap, 30, true));
    // lastSuccessAt ≈ now; the output must include a time-looking string (HH:MM)
    expect(logs.join('\n')).toMatch(/\d+:\d+/);
  });

  // TC-E08: renderError shows error message in output
  it('TC-E08: renderError shows the error message in output', async () => {
    recordPollFailure();
    const snap = buildErrorSnapshot(new Error('Railway DB gone'));
    const { logs } = await captureStdout(() => renderError(snap, 30, true));
    expect(logs.join('\n')).toMatch(/Railway DB gone/);
  });

  // TC-E09: renderError shows retry interval
  it('TC-E09: renderError shows retry interval from intervalSec param', async () => {
    recordPollFailure();
    const snap = buildErrorSnapshot(new Error('x'));
    const { logs } = await captureStdout(() => renderError(snap, 45, true));
    expect(logs.join('\n')).toMatch(/45s/);
  });

  // TC-E10: Bell emitted on FIRST failure, not subsequent (silent=false)
  it('TC-E10: bell (\\x07) emitted on first failure only', async () => {
    // First failure → consecutiveFailures=1 → bell
    resetPollError();
    recordPollFailure();
    const snap1 = buildErrorSnapshot(new Error('first'));
    const { stdout: out1 } = await captureStdout(() => renderError(snap1, 30, false));
    expect(out1).toContain('\x07');

    // Second failure → consecutiveFailures=2 → no bell
    recordPollFailure();
    const snap2 = buildErrorSnapshot(new Error('second'));
    const { stdout: out2 } = await captureStdout(() => renderError(snap2, 30, false));
    expect(out2).not.toContain('\x07');
  });

  // TC-E11: Bell suppressed when silent=true even on first failure
  it('TC-E11: silent=true suppresses bell on first failure', async () => {
    resetPollError();
    recordPollFailure();
    const snap = buildErrorSnapshot(new Error('silent'));
    const { stdout } = await captureStdout(() => renderError(snap, 30, true));
    expect(stdout).not.toContain('\x07');
  });

  // TC-E12: resetPollError advances lastSuccessAt to approximately now
  it('TC-E12: resetPollError updates lastSuccessAt to current time', () => {
    const before = Date.now();
    resetPollError();
    const after = Date.now();
    const recorded = getLastSuccessAt();
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(after);
  });
});
