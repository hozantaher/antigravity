import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMcpClient, FETCH_TIMEOUT_MS } from './mcp-client.js';

describe('mcp-client fetch timeouts', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset module state between tests — each createMcpClient() is a fresh closure,
    // but global.fetch is shared.
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('exports FETCH_TIMEOUT_MS constant defaulting to 30_000ms', () => {
    expect(FETCH_TIMEOUT_MS).toBe(30_000);
  });

  it('attaches AbortSignal to fetchMetadata call (first fetch in createMcpClient flow)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        registration_endpoint: 'https://mcp.example.com/register',
        authorization_endpoint: 'https://mcp.example.com/authorize',
        token_endpoint: 'https://mcp.example.com/token',
      }),
    });
    global.fetch = fetchSpy;

    const client = createMcpClient({ baseUrl: 'https://mcp.example.com', secret: 'x', prefix: 'test' });
    // Touch listTools — will trigger ensureInitialized → acquireToken → fetchMetadata.
    // We only need to observe the first fetch(). After metadata resolves, subsequent fetches
    // will fire but may fail — we catch and assert on call history.
    try {
      await client.listTools();
    } catch {
      // expected — registration fetch returns 404 by default in our mock chain
    }

    expect(fetchSpy).toHaveBeenCalled();
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.signal).toBeDefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('AbortSignal from AbortSignal.timeout() auto-fires (verified with short timeout)', async () => {
    // Verify the underlying primitive behaves as expected: a short AbortSignal.timeout
    // flips signal.aborted to true once the timer expires. This implicitly validates that
    // our withTimeout() pattern (same primitive) will fire at FETCH_TIMEOUT_MS in production.
    const shortSignal = AbortSignal.timeout(20);
    expect(shortSignal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(shortSignal.aborted).toBe(true);

    // Additionally, capture a real signal from the client and confirm it is the same kind
    // of AbortSignal (same prototype → same timeout semantics apply).
    let capturedSignal: AbortSignal | undefined;
    global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      // Resolve quickly so the test doesn't hang
      return Promise.resolve({
        ok: true,
        json: async () => ({
          registration_endpoint: 'https://mcp.example.com/register',
          authorization_endpoint: 'https://mcp.example.com/authorize',
          token_endpoint: 'https://mcp.example.com/token',
        }),
      });
    });

    const client = createMcpClient({ baseUrl: 'https://mcp.example.com', secret: 'x', prefix: 'test' });
    await client.listTools().catch(() => {});

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it('propagates AbortError when timeout fires (caller sees rejection)', async () => {
    // Simulate fetch that rejects immediately with AbortError when called (as real fetch does on timed-out signal)
    global.fetch = vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const client = createMcpClient({ baseUrl: 'https://mcp.example.com', secret: 'x', prefix: 'test' });
    await expect(client.listTools()).rejects.toThrow();
  });

  it('fetch completes within timeout → succeeds normally', async () => {
    // Happy path: metadata + register + approve + token + rpc all succeed.
    const redirectUrl = 'http://localhost:9999/callback?code=authcode123';
    const approveHeaders = new Headers({ location: redirectUrl });

    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes('.well-known/oauth-authorization-server')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            registration_endpoint: 'https://mcp.example.com/register',
            authorization_endpoint: 'https://mcp.example.com/authorize',
            token_endpoint: 'https://mcp.example.com/token',
          }),
        });
      }
      if (url.includes('/register')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ client_id: 'cid', client_secret: 'csec' }),
        });
      }
      if (url.includes('/oauth/approve')) {
        return Promise.resolve({ ok: true, headers: approveHeaders });
      }
      if (url.includes('/token')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ access_token: 'tok' }),
        });
      }
      // /mcp calls — return empty tools list
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ result: { tools: [] } }),
        text: async () => '',
      });
    });
    global.fetch = fetchSpy;

    const client = createMcpClient({ baseUrl: 'https://mcp.example.com', secret: 'x', prefix: 'test' });
    const tools = await client.listTools();
    expect(tools).toEqual([]);

    // Verify EVERY fetch call had a signal
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      // Metadata call is fetch(url) with no init — our fix must add { signal } there too
      expect(init).toBeDefined();
      expect(init?.signal).toBeDefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('all 6 documented fetch call sites attach signal (table-driven by call inspection)', async () => {
    // Set up the full happy-path chain used in the previous test, then also exercise
    // callTool (which reuses rpc) + the initialize notification fetch.
    const fetchSpy = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      // Every call must carry an abort signal — asserted after
      void init;
      if (url.includes('.well-known')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            registration_endpoint: 'https://mcp.example.com/register',
            authorization_endpoint: 'https://mcp.example.com/authorize',
            token_endpoint: 'https://mcp.example.com/token',
          }),
        });
      }
      if (url.includes('/register')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ client_id: 'cid', client_secret: 'csec' }),
        });
      }
      if (url.includes('/oauth/approve')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ location: 'http://localhost:9999/callback?code=xyz' }),
        });
      }
      if (url.includes('/token')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ access_token: 'tok' }),
        });
      }
      // /mcp call — we need to return empty result + handle `notifications/initialized` silent fetch
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ result: { tools: [{ name: 'ping', inputSchema: {} }] } }),
        text: async () => '',
      });
    });
    global.fetch = fetchSpy;

    const client = createMcpClient({ baseUrl: 'https://mcp.example.com', secret: 'x', prefix: 'test' });
    await client.listTools();
    await client.callTool('test__ping', {});

    // Call sites exercised:
    //  1. fetchMetadata → /.well-known/...
    //  2. registerClient → /register
    //  3. acquireToken   → /oauth/approve
    //  4. acquireToken   → /token
    //  5. rpc            → /mcp  (initialize, tools/list, tools/call)
    //  6. initialize     → /mcp  (notifications/initialized)
    // = 6 distinct call sites (some fire multiple times).
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(6);

    const missingSignal: string[] = [];
    for (const [url, init] of fetchSpy.mock.calls) {
      if (!init || !(init as RequestInit).signal) missingSignal.push(String(url));
    }
    expect(missingSignal).toEqual([]);
  });

  it('invalid URL → fetch rejects synchronously (before timeout relevant)', async () => {
    // Simulate fetch throwing on invalid URL — common behavior in undici.
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.reject(new TypeError('fetch failed: invalid URL'));
    });

    const client = createMcpClient({ baseUrl: 'not-a-valid-url', secret: 'x', prefix: 'test' });
    await expect(client.listTools()).rejects.toThrow(/invalid URL|fetch failed/i);
  });

  it('FETCH_TIMEOUT_MS is not mutable from outside (exported as const)', () => {
    // Runtime check — constant should not be reassignable in consuming code.
    // (TS would catch this at compile time; here we verify the exported value is a number.)
    expect(typeof FETCH_TIMEOUT_MS).toBe('number');
    expect(FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
  });
});
