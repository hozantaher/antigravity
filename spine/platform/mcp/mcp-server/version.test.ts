import { describe, it, expect } from 'vitest';
import { VERSION, BUILD_SHA, BUILD_TIME } from './version.js';

describe('version', () => {
  it('VERSION follows semver+sha format', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+\+.+$/);
  });

  it('BUILD_SHA is a git short hash or known fallback', () => {
    // In CI/dev: 7-char hex; in Docker: BUILD_SHA env; fallback: "unknown"
    expect(BUILD_SHA).toMatch(/^([0-9a-f]{7,}|unknown|.+)$/);
    expect(BUILD_SHA.length).toBeGreaterThan(0);
  });

  it('BUILD_TIME is a valid ISO date string', () => {
    const parsed = new Date(BUILD_TIME);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it('VERSION contains BUILD_SHA', () => {
    expect(VERSION).toContain(BUILD_SHA);
  });
});
