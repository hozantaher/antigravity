import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createHash, randomBytes } from 'crypto';
import { createTestDatabase } from './test-utils.js';

// --- Setup test sources before any tool imports ---

const { esbirkaSource, judikatySource } = createTestDatabase();

// Must set test sources before importing http.js which triggers tool registration
const { _setTestSources } = await import('./tools.js');
_setTestSources(
  new Map([
    ['esbirka', esbirkaSource],
    ['judikaty', judikatySource],
  ]),
);

const { startHttpServer } = await import('./http.js');
const { createMemoryStore } = await import('./auth.js');
const { createMcpClient } = await import('../scripts/lib/mcp-client.js');

// --- Server lifecycle ---

let server: Server;
let baseUrl: string;
const SECRET = 'e2e-test-secret';

function generatePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Find a free port by briefly binding to port 0 */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const tmp = createServer();
    tmp.listen(0, () => {
      const port = (tmp.address() as AddressInfo).port;
      tmp.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Register an OAuth client + do PKCE flow, return access token */
async function acquireTokenManually(): Promise<string> {
  // Register client
  const regRes = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'e2e-manual',
      redirect_uris: ['http://localhost:9999/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  const client = (await regRes.json()) as { client_id: string; client_secret: string };

  // Approve with PKCE
  const { verifier, challenge } = generatePkce();
  const approveRes = await fetch(`${baseUrl}/oauth/approve`, {
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
  const location = approveRes.headers.get('location')!;
  const code = new URL(location).searchParams.get('code')!;

  // Token exchange
  const meta = (await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json()) as {
    token_endpoint: string;
  };
  const tokenRes = await fetch(meta.token_endpoint, {
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
  const tokenData = (await tokenRes.json()) as { access_token: string };
  return tokenData.access_token;
}

beforeAll(async () => {
  const port = await findFreePort();
  baseUrl = `http://localhost:${port}`;
  const store = createMemoryStore();
  const result = startHttpServer(port, baseUrl, SECRET, store);
  server = result.server;

  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.on('listening', resolve);
  });
}, 10_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  // pool cleanup not needed for mock
});

// ========================================
// Group 1: Health Check
// ========================================

describe('Health check', () => {
  it('GET /health returns 200 with version info', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.version).toBeDefined();
    expect(typeof body.uptimeSeconds).toBe('number');
  });
});

// ========================================
// Group 2: OAuth Lifecycle (raw fetch)
// ========================================

describe('OAuth lifecycle', () => {
  it('metadata endpoint returns required fields', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, string>;
    expect(meta.registration_endpoint).toBeDefined();
    expect(meta.authorization_endpoint).toBeDefined();
    expect(meta.token_endpoint).toBeDefined();
  });

  it('client registration returns client_id and client_secret', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-reg-test',
        redirect_uris: ['http://localhost:9999/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    expect(res.status).toBe(201);
    const client = (await res.json()) as Record<string, string>;
    expect(client.client_id).toBeDefined();
    expect(client.client_secret).toBeDefined();
  });

  it('approve with wrong secret returns 403', async () => {
    const res = await fetch(`${baseUrl}/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'any',
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: 'test',
        secret: 'wrong-secret',
      }).toString(),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Wrong secret');
  });

  it('approve with unregistered client returns 400', async () => {
    const res = await fetch(`${baseUrl}/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'nonexistent-client-id',
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: 'test',
        secret: SECRET,
      }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
  });

  it('full PKCE flow: register → approve → token exchange', async () => {
    const token = await acquireTokenManually();
    expect(token).toBeDefined();
    expect(token.length).toBeGreaterThan(0);
  });

  it('reused auth code is rejected', async () => {
    // Register + approve
    const regRes = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-reuse',
        redirect_uris: ['http://localhost:9999/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    const client = (await regRes.json()) as { client_id: string; client_secret: string };
    const { verifier, challenge } = generatePkce();

    const approveRes = await fetch(`${baseUrl}/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: challenge,
        secret: SECRET,
      }).toString(),
      redirect: 'manual',
    });
    const code = new URL(approveRes.headers.get('location')!).searchParams.get('code')!;
    const meta = (await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json()) as {
      token_endpoint: string;
    };

    // First exchange — should succeed
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier,
      redirect_uri: 'http://localhost:9999/callback',
    }).toString();

    const firstRes = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    expect(firstRes.status).toBe(200);

    // Second exchange with same code — should fail (400 or 500 depending on SDK version)
    const secondRes = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    expect(secondRes.ok).toBe(false);
  });
});

// ========================================
// Group 3: MCP Session Management
// ========================================

describe('MCP session management', () => {
  let token: string;

  beforeAll(async () => {
    token = await acquireTokenManually();
  });

  const mcpHeaders = () => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  });

  it('initialize creates session with mcp-session-id', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'e2e-session', version: '1.0.0' },
        },
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('unknown session ID returns 404', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders(), 'mcp-session-id': 'nonexistent-session' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Session not found');
  });

  it('unauthenticated request returns 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
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

  it('invalid token returns 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer invalid-token-12345',
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

  it('session reuse works across requests', async () => {
    // Initialize — get session ID
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'e2e-reuse', version: '1.0.0' },
        },
      }),
    });
    const sid = initRes.headers.get('mcp-session-id')!;
    expect(sid).toBeTruthy();

    // Send notifications/initialized
    await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders(), 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    // Use same session for tools/list
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders(), 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list' }),
    });
    expect(listRes.ok).toBe(true);
  });
});

// ========================================
// Group 4: Tool Execution via createMcpClient
// ========================================

describe('Tool execution via MCP client', () => {
  let mcp: ReturnType<typeof createMcpClient>;

  beforeAll(async () => {
    mcp = createMcpClient({ baseUrl, secret: SECRET, prefix: 'e2e' });
  });

  function callTool(name: string, args: Record<string, unknown> = {}) {
    return mcp.callTool(`e2e__${name}`, args);
  }

  function getText(result: { content: Array<{ type: string; text: string }> }) {
    return result.content.map((c) => c.text).join('\n');
  }

  // --- Discovery ---

  describe('tool discovery', () => {
    it('listTools returns all 7 tools', async () => {
      const tools = await mcp.listTools();
      expect(tools.length).toBe(7);
      const names = tools.map((t) => t.name.replace('e2e__', ''));
      for (const tool of [
        'query',
        'read_paragraphs',
        'search',
        'get_law_context',
        'get_decision',
        'get_stats',
        'get_schema',
      ]) {
        expect(names).toContain(tool);
      }
    });
  });

  // --- query ---

  describe('query tool', () => {
    it('valid SELECT returns rows', async () => {
      const result = await callTool('query', { source: 'esbirka', sql: 'SELECT citace, nazev FROM acts' });
      const text = getText(result);
      const parsed = JSON.parse(text);
      expect(parsed.rowCount).toBe(2);
      expect(parsed.columns).toContain('citace');
    });

    it('SQL error returns isError', async () => {
      const result = await callTool('query', { source: 'esbirka', sql: 'SELECT * FROM nonexistent_table' });
      expect(result.isError).toBe(true);
    });

    it('respects limit parameter', async () => {
      const result = await callTool('query', { source: 'esbirka', sql: 'SELECT * FROM acts', limit: 1 });
      const parsed = JSON.parse(getText(result));
      expect(parsed.rowCount).toBe(1);
    });
  });

  // --- search ---

  describe('search tool', () => {
    it('FTS5 returns results with snippets', async () => {
      const result = await callTool('search', {
        source: 'judikaty',
        table: 'decisions',
        query: 'zprostředkov*',
        columns: ['pravni_veta'],
      });
      const parsed = JSON.parse(getText(result));
      expect(parsed.rowCount).toBeGreaterThan(0);
      expect(parsed.rows[0]).toHaveProperty('pravni_veta_snippet');
    });

    it('returns empty for nonexistent term', async () => {
      const result = await callTool('search', {
        source: 'judikaty',
        table: 'decisions',
        query: 'xyznonexistent999',
        columns: ['pravni_veta'],
      });
      const parsed = JSON.parse(getText(result));
      expect(parsed.rowCount).toBe(0);
    });

    it('invalid filter generates warning', async () => {
      const result = await callTool('search', {
        source: 'judikaty',
        table: 'decisions',
        query: 'test',
        columns: ['pravni_veta'],
        filter: 'source = nsoud',
      });
      const parsed = JSON.parse(getText(result));
      expect(parsed.warning).toBeDefined();
      expect(parsed.warning).toContain('ignored');
    });
  });

  // --- read_paragraphs ---

  describe('read_paragraphs tool', () => {
    it('extracts specific paragraphs from 89/2012 Sb.', async () => {
      const result = await callTool('read_paragraphs', {
        source: 'esbirka',
        citace: '89/2012 Sb.',
        paragraphs: ['2445', '2446'],
      });
      const text = getText(result);
      expect(text).toContain('§ 2445');
      expect(text).toContain('§ 2446');
      expect(text).toContain('zprostředkovatel');
    });

    it('reports missing paragraphs', async () => {
      const result = await callTool('read_paragraphs', {
        source: 'esbirka',
        citace: '89/2012 Sb.',
        paragraphs: ['9999'],
      });
      const text = getText(result);
      expect(text).toContain('9999');
    });
  });

  // --- get_law_context ---

  describe('get_law_context tool', () => {
    it('returns metadata with relationships', async () => {
      const result = await callTool('get_law_context', {
        source: 'esbirka',
        citace: '89/2012 Sb.',
      });
      const text = getText(result);
      expect(text).toContain('Zákon občanský zákoník');
      expect(text).toContain('MENI');
    });

    it('unknown law returns not found', async () => {
      const result = await callTool('get_law_context', {
        source: 'esbirka',
        citace: 'NOPE/0000 Sb.',
      });
      const text = getText(result);
      expect(text.toLowerCase()).toContain('nenalezen');
    });
  });

  // --- get_decision ---

  describe('get_decision tool', () => {
    it('finds by case number (spisova_znacka)', async () => {
      const result = await callTool('get_decision', {
        source: 'judikaty',
        identifier: 'I.ÚS 52/25',
      });
      const text = getText(result);
      expect(text).toContain('Ústavní soud');
    });

    it('finds by ECLI', async () => {
      const result = await callTool('get_decision', {
        source: 'judikaty',
        identifier: 'ECLI:CZ:NS:2009:33.CDO.2675.2007.1',
      });
      const text = getText(result);
      expect(text).toContain('Nejvyšší soud');
    });

    it('unknown decision returns not found', async () => {
      const result = await callTool('get_decision', {
        source: 'judikaty',
        identifier: 'XXXXX/9999',
      });
      const text = getText(result);
      expect(text.toLowerCase()).toContain('nenalezeno');
    });

    it('respects sections parameter', async () => {
      const result = await callTool('get_decision', {
        source: 'judikaty',
        identifier: 'I.ÚS 52/25',
        sections: 'metadata',
      });
      const text = getText(result);
      expect(text).toContain('Ústavní soud');
      expect(text).not.toContain('## Výrok');
    });

    it('decompresses gzipped oduvodneni', async () => {
      const result = await callTool('get_decision', {
        source: 'judikaty',
        identifier: 'GZ 1/2026',
        sections: 'all',
      });
      const text = getText(result);
      expect(text).toContain('Komprimované odůvodnění');
    });
  });

  // --- get_stats ---

  describe('get_stats tool', () => {
    it('returns stats for specific source', async () => {
      const result = await callTool('get_stats', { source: 'judikaty' });
      const text = getText(result);
      expect(text).toContain('judikaty');
      expect(text).toContain('decisions');
    });

    it('returns stats for all sources when no source specified', async () => {
      const result = await callTool('get_stats', {});
      const text = getText(result);
      expect(text).toContain('esbirka');
      expect(text).toContain('judikaty');
    });
  });

  // --- get_schema ---

  describe('get_schema tool', () => {
    it('returns CREATE TABLE statements', async () => {
      const result = await callTool('get_schema', { source: 'esbirka' });
      const text = getText(result);
      expect(text).toContain('CREATE TABLE');
      expect(text).toContain('acts');
    });
  });
}, 30_000);

// ========================================
// Group 5: Concurrency
// ========================================

describe('Concurrent tool calls', () => {
  it('3 parallel calls succeed', async () => {
    const mcp = createMcpClient({ baseUrl, secret: SECRET, prefix: 'conc' });
    const results = await Promise.all([
      mcp.callTool('conc__get_stats', {}),
      mcp.callTool('conc__query', { source: 'esbirka', sql: 'SELECT COUNT(*) FROM acts' }),
      mcp.callTool('conc__get_schema', { source: 'judikaty' }),
    ]);
    for (const r of results) {
      expect(r.isError).toBeFalsy();
      expect(r.content.length).toBeGreaterThan(0);
    }
  }, 15_000);
});
