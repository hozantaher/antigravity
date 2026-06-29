// W2-G — locks the rule that mcp-client.ts adds AbortSignal.timeout
// to every fetch. Pre-fix every fetch was unbounded; a hung Railway
// MCP service blocked the BullMQ worker indefinitely.
//
// Source-level audit. Behavioral runtime test would require spinning
// up a fake MCP HTTP server with intentionally-stalled responses;
// the regression-detection signal here is unambiguous from the
// source shape.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(__dirname, 'mcp-client.ts'), 'utf8');

// Strip line + block comments so the regression-doc comment that
// legitimately mentions the prior unbounded fetch doesn't trip the
// audit.
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

const code = stripComments(SOURCE);

describe('W2-G — mcp-client fetch timeouts', () => {
  it('every fetch( call has a signal: AbortSignal.timeout(...)', () => {
    // Count fetch( call sites and signal: AbortSignal.timeout occurrences.
    // Goal: every fetch site is paired with a timeout.
    const fetchCalls = (code.match(/fetch\(/g) ?? []).length;
    const signaled = (code.match(/signal:\s*AbortSignal\.timeout\(/g) ?? []).length;
    expect(fetchCalls, 'expected ≥ 5 fetch sites in mcp-client.ts').toBeGreaterThanOrEqual(5);
    expect(signaled, `signal count (${signaled}) must equal fetch count (${fetchCalls})`).toBe(fetchCalls);
  });

  it('uses a single fetchTimeoutMs constant (env-overridable via MCP_FETCH_TIMEOUT_MS)', () => {
    expect(code).toContain('MCP_FETCH_TIMEOUT_MS');
    expect(code).toContain('AbortSignal.timeout(fetchTimeoutMs)');
  });

  it('default timeout is between 5s and 60s', () => {
    // Pull the default value from the `?? 30_000` shape.
    const m = code.match(/MCP_FETCH_TIMEOUT_MS\s*\?\?\s*([\d_]+)/);
    expect(m, 'default value not found').not.toBeNull();
    const def = Number(m![1].replace(/_/g, ''));
    expect(def).toBeGreaterThanOrEqual(5_000);
    expect(def).toBeLessThanOrEqual(60_000);
  });

  it('does NOT contain a bare fetch( without options object', () => {
    // The shape `await fetch(url);` (no options at all) cannot have a
    // signal — so it's a bug. Look for fetch( followed by a single
    // string-quoted or template-literal argument and a closing `);`.
    expect(code).not.toMatch(/await fetch\([^,()]*\);/);
    expect(code).not.toMatch(/= fetch\([^,()]*\);/);
  });
});
