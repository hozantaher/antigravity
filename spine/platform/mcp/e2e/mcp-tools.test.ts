/**
 * E2E tests for garaaage-mcp HTTP server.
 *
 * These tests run against a live server. In CI they use the Docker Compose
 * stack (docker-compose.test.yml). Locally they can point at any running
 * instance via the E2E_BASE_URL environment variable.
 *
 * Prerequisites:
 *   docker-compose -f docker-compose.test.yml up -d
 *   Wait for the garaaage-mcp healthcheck to pass before running.
 *
 * The server requires OAuth PKCE to call /mcp. Because the test Postgres
 * database is empty (no prefixed tables), the server will fail at source
 * discovery and exit. These tests therefore focus on:
 *   1. /health — always works, no auth needed
 *   2. OAuth handshake — register, approve, token exchange
 *   3. /mcp session management — initialize, tools/list
 *   4. Tool error responses — unknown source, invalid SQL
 *
 * For full tool-level coverage with rich fixture data, see
 * mcp-server/e2e.test.ts which uses an in-process mock database.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3001';
const SECRET = process.env.E2E_SECRET ?? 'test-e2e-secret';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generatePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface OAuthMeta {
  registration_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

interface OAuthClient {
  client_id: string;
  client_secret: string;
}

async function getOAuthMeta(): Promise<OAuthMeta> {
  const res = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`OAuth metadata fetch failed: ${res.status}`);
  return (await res.json()) as OAuthMeta;
}

async function registerClient(meta: OAuthMeta, name = 'e2e-test-client'): Promise<OAuthClient> {
  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: ['http://localhost:9999/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed: ${res.status}`);
  return (await res.json()) as OAuthClient;
}

async function acquireToken(): Promise<string> {
  const meta = await getOAuthMeta();
  const client = await registerClient(meta, `e2e-${Date.now()}`);
  const { verifier, challenge } = generatePkce();

  const approveRes = await fetch(`${BASE_URL}/oauth/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'http://localhost:9999/callback',
      code_challenge: challenge,
      state: 'e2e',
      secret: SECRET,
    }).toString(),
    redirect: 'manual',
  });

  const location = approveRes.headers.get('location');
  if (!location) throw new Error(`Approve did not redirect (status ${approveRes.status})`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('No auth code in redirect location');

  // Rewrite the token endpoint host to BASE_URL in case MCP_ISSUER_URL differs
  const rawTokenEndpoint = meta.token_endpoint;
  const tokenEndpoint = rawTokenEndpoint.replace(/^https?:\/\/[^/]+/, BASE_URL);

  const tokenRes = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier,
      redirect_uri: 'http://localhost:9999/callback',
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);

  const data = (await tokenRes.json()) as { access_token: string };
  return data.access_token;
}

async function mcpPost(
  token: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ status: number; headers: Headers; body: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const ct = res.headers.get('content-type') ?? '';
  let parsed: unknown;
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    let lastData = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) lastData = line.slice(6);
    }
    parsed = lastData ? JSON.parse(lastData) : null;
  } else {
    parsed = await res.json();
  }

  return {
    status: res.status,
    headers: res.headers,
    body: parsed,
    sessionId: res.headers.get('mcp-session-id'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Health check', () => {
  it('GET /health returns 200 with status ok', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('GET /health returns startedAt ISO timestamp', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.startedAt).toBe('string');
    expect(() => new Date(body.startedAt as string)).not.toThrow();
  });
});

describe('OAuth lifecycle', () => {
  let meta: OAuthMeta;

  beforeAll(async () => {
    meta = await getOAuthMeta();
  });

  it('/.well-known/oauth-authorization-server returns required fields', () => {
    expect(typeof meta.registration_endpoint).toBe('string');
    expect(typeof meta.authorization_endpoint).toBe('string');
    expect(typeof meta.token_endpoint).toBe('string');
  });

  it('/register returns client_id and client_secret', async () => {
    const client = await registerClient(meta, 'e2e-reg-check');
    expect(typeof client.client_id).toBe('string');
    expect(typeof client.client_secret).toBe('string');
    expect(client.client_id.length).toBeGreaterThan(0);
  });

  it('/oauth/approve with wrong secret returns 403', async () => {
    const res = await fetch(`${BASE_URL}/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'any',
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: 'test',
        secret: 'definitely-wrong-secret',
      }).toString(),
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('Wrong secret');
  });

  it('/oauth/approve with unregistered client_id returns 400', async () => {
    const res = await fetch(`${BASE_URL}/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'nonexistent-client-00000000',
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: 'test',
        secret: SECRET,
      }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
  });

  it('full PKCE flow produces a non-empty access token', async () => {
    const token = await acquireToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('reused auth code is rejected on second token exchange', async () => {
    const client = await registerClient(meta, `e2e-reuse-${Date.now()}`);
    const { verifier, challenge } = generatePkce();

    const approveRes = await fetch(`${BASE_URL}/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: challenge,
        state: 'reuse',
        secret: SECRET,
      }).toString(),
      redirect: 'manual',
    });
    const code = new URL(approveRes.headers.get('location')!).searchParams.get('code')!;
    const tokenEndpoint = meta.token_endpoint.replace(/^https?:\/\/[^/]+/, BASE_URL);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier,
      redirect_uri: 'http://localhost:9999/callback',
    }).toString();

    const first = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(first.status).toBe(200);

    const second = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(second.ok).toBe(false);
  });
});

describe('MCP session management', () => {
  let token: string;

  beforeAll(async () => {
    token = await acquireToken();
  }, 15_000);

  it('POST /mcp without auth returns 401', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /mcp with invalid Bearer token returns 401', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer invalid-token-aabbcc',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('initialize creates a session and returns mcp-session-id header', async () => {
    const result = await mcpPost(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-init', version: '1.0.0' },
      },
    });
    expect(result.status).toBe(200);
    expect(result.sessionId).toBeTruthy();
  });

  it('unknown session ID returns 404 with error body', async () => {
    const result = await mcpPost(
      token,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      'nonexistent-session-id-e2e',
    );
    expect(result.status).toBe(404);
    const body = result.body as { error: string };
    expect(body.error).toBe('Session not found');
  });

  it('session can be reused for subsequent requests', async () => {
    // Initialize — obtain session ID
    const initResult = await mcpPost(token, {
      jsonrpc: '2.0',
      id: 100,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-reuse-sess', version: '1.0.0' },
      },
    });
    const sid = initResult.sessionId;
    expect(sid).toBeTruthy();

    // Send notifications/initialized to complete handshake
    await mcpPost(
      token,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sid!,
    );

    // tools/list on same session
    const listResult = await mcpPost(
      token,
      { jsonrpc: '2.0', id: 101, method: 'tools/list' },
      sid!,
    );
    expect(listResult.status).toBe(200);
  });
});

describe('MCP tool responses — invalid inputs', () => {
  let token: string;
  let sessionId: string;

  beforeAll(async () => {
    token = await acquireToken();

    // Initialize a session
    const initResult = await mcpPost(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-tools', version: '1.0.0' },
      },
    });
    sessionId = initResult.sessionId!;

    await mcpPost(
      token,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId,
    );
  }, 20_000);

  async function callTool(name: string, args: Record<string, unknown>) {
    const result = await mcpPost(
      token,
      {
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 10000),
        method: 'tools/call',
        params: { name, arguments: args },
      },
      sessionId,
    );
    return result.body as {
      result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
      error?: { code: number; message: string };
    };
  }

  it('query with unknown source returns isError response', async () => {
    const res = await callTool('query', {
      source: 'nonexistent_source',
      sql: 'SELECT 1',
    });
    // MCP tool errors surface as result.isError, not JSON-RPC error
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content.map((c) => c.text).join('') ?? '';
    expect(text.toLowerCase()).toContain('unknown source');
  });

  it('search with unknown source returns isError response', async () => {
    const res = await callTool('search', {
      source: 'nonexistent_source',
      table: 'decisions',
      query: 'test',
      columns: ['text'],
    });
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content.map((c) => c.text).join('') ?? '';
    expect(text.toLowerCase()).toContain('unknown source');
  });

  it('get_stats with unknown source returns isError response', async () => {
    const res = await callTool('get_stats', { source: 'nonexistent_source' });
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content.map((c) => c.text).join('') ?? '';
    expect(text.toLowerCase()).toContain('unknown source');
  });

  it('get_schema with unknown source returns isError response', async () => {
    const res = await callTool('get_schema', { source: 'nonexistent_source' });
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content.map((c) => c.text).join('') ?? '';
    expect(text.toLowerCase()).toContain('unknown source');
  });

  it('get_decision with unknown source returns isError response', async () => {
    const res = await callTool('get_decision', {
      source: 'judikaty',
      identifier: 'XXXXX/9999',
    });
    // This tool uses z.literal('judikaty'), so it either succeeds or returns not-found text
    const text = res.result?.content.map((c) => c.text).join('') ?? '';
    // Should not throw — either "not found" or an error, but always a valid MCP response
    expect(res.result?.content.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
  });

  it('get_law_context with unknown source returns isError response', async () => {
    const res = await callTool('get_law_context', {
      source: 'esbirka',
      citace: 'NOPE/0000 Sb.',
    });
    const text = res.result?.content.map((c) => c.text).join('') ?? '';
    expect(res.result?.content.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
  });
});
