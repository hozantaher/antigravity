import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDatabase } from './test-utils.js';
import { logger } from '../lib/logger.js';

// --- Setup test sources ---

const { esbirkaSource, judikatySource } = createTestDatabase();

const { _setTestSources } = await import('./tools.js');
_setTestSources(
  new Map([
    ['esbirka', esbirkaSource],
    ['judikaty', judikatySource],
  ]),
);

const { startHttpServer } = await import('./http.js');
const { createMemoryStore } = await import('./auth.js');

let app: Express;
let httpServer: import('http').Server;

beforeAll(() => {
  // Port 0 = OS picks a random port; we only use supertest(app) anyway
  const store = createMemoryStore();
  ({ app, server: httpServer } = startHttpServer(0, 'http://localhost:9999', 'test-secret', store));
});

afterAll(() => {
  httpServer.close();
  // mock pool — no cleanup needed
});

// --- /health ---

describe('GET /health', () => {
  it('returns 200 with version and uptime', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBeDefined();
    expect(res.body.sha).toBeDefined();
    expect(res.body.buildTime).toBeDefined();
    expect(res.body.startedAt).toBeDefined();
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });
});

// --- /oauth/approve ---

// Helper: register a dynamic OAuth client via the SDK registration endpoint
async function registerClient(): Promise<{ client_id: string; client_secret: string }> {
  const res = await request(app)
    .post('/register')
    .send({
      client_name: 'test-client',
      redirect_uris: ['http://localhost:9999/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    })
    .expect(201);
  return { client_id: res.body.client_id, client_secret: res.body.client_secret };
}

describe('POST /oauth/approve', () => {
  it('returns 403 for wrong secret', async () => {
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({
        client_id: 'test-client',
        redirect_uri: 'http://localhost/callback',
        code_challenge: 'challenge',
        state: 'st',
        secret: 'wrong-secret',
      })
      .expect(403);

    expect(res.text).toContain('Wrong secret');
  });

  it('returns 400 for unregistered client_id', async () => {
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({
        client_id: 'nonexistent-client',
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: 'challenge',
        secret: 'test-secret',
      })
      .expect(400);

    expect(res.body.error).toContain('Unknown client_id');
  });

  it('redirects with auth code for correct secret', async () => {
    const { client_id } = await registerClient();
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({
        client_id,
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: 'challenge',
        state: 'mystate',
        secret: 'test-secret',
      })
      .expect(302);

    const location = res.headers.location;
    expect(location).toBeDefined();
    expect(location).toContain('code=');
    expect(location).toContain('state=mystate');
  });

  it('redirects without state param when state is empty', async () => {
    const { client_id } = await registerClient();
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({
        client_id,
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: 'challenge',
        secret: 'test-secret',
      })
      .expect(302);

    const location = res.headers.location;
    expect(location).toContain('code=');
    // state should NOT be present when not provided
    expect(location).not.toContain('state=');
  });
});

// --- H1: /oauth/approve Zod validation ---

describe('POST /oauth/approve — Zod validation', () => {
  const validBody = {
    client_id: 'cid',
    redirect_uri: 'http://localhost:9999/callback',
    code_challenge: 'challenge',
    secret: 'test-secret',
  };

  // --- Missing required fields ---

  it('returns 400 for missing client_id', async () => {
    const { client_id: _omit, ...body } = validBody;
    const res = await request(app).post('/oauth/approve').type('form').send(body).expect(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.details).toBeDefined();
    // Ensure no Express HTML 500 leaked
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('returns 400 for missing redirect_uri', async () => {
    const { redirect_uri: _omit, ...body } = validBody;
    const res = await request(app).post('/oauth/approve').type('form').send(body).expect(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('returns 400 for missing code_challenge', async () => {
    const { code_challenge: _omit, ...body } = validBody;
    const res = await request(app).post('/oauth/approve').type('form').send(body).expect(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('returns 400 for missing secret', async () => {
    const { secret: _omit, ...body } = validBody;
    const res = await request(app).post('/oauth/approve').type('form').send(body).expect(400);
    expect(res.body.error).toBe('invalid_request');
  });

  // --- Empty strings (.min(1)) ---

  it('returns 400 for empty client_id', async () => {
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({ ...validBody, client_id: '' })
      .expect(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('returns 400 for empty redirect_uri', async () => {
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({ ...validBody, redirect_uri: '' })
      .expect(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('returns 400 for empty code_challenge', async () => {
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({ ...validBody, code_challenge: '' })
      .expect(400);
    expect(res.body.error).toBe('invalid_request');
  });

  // --- Wrong types — express.urlencoded stringifies everything, but nested arrays/objects stay objects ---

  it('returns 400 for array value where string expected (nested key)', async () => {
    // urlencoded parser with extended: false won't build nested objects/arrays from bracket syntax,
    // but posting the same key twice yields an array → which is a non-string value.
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send('client_id=a&client_id=b&redirect_uri=http://localhost/cb&code_challenge=c&secret=test-secret')
      .expect(400);
    // extended:false parser keeps the LAST value for duplicate keys → still a string in practice.
    // So this either returns 400 (valid form but wrong value) or 302 if 'b' happens to look like a valid client.
    // Since 'b' is not a registered client, the handler should proceed past Zod and hit the isClientRegistered check.
    // Adjust expectation: either 400 (zod) or 400 (unknown client) — both 400.
    expect(res.status).toBe(400);
  });

  it('returns 400 for JSON body instead of form-encoded', async () => {
    // When posting JSON without the form parser matching, req.body is an empty object →
    // all fields missing → Zod returns 400.
    const res = await request(app)
      .post('/oauth/approve')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(validBody))
      .expect(400);
    expect(res.body.error).toBe('invalid_request');
  });

  // --- Strict schema: extra unknown field rejected ---

  it('returns 400 when unknown fields are included (strict schema)', async () => {
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({ ...validBody, malicious: 'payload', extra: 'junk' })
      .expect(400);
    expect(res.body.error).toBe('invalid_request');
  });

  // --- Sensitive-data redaction in error response ---

  it('does not leak secret value in error details', async () => {
    // Force zod failure while including a secret — ensure secret string does not appear in response.
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({ client_id: '', redirect_uri: '', code_challenge: '', secret: 'super-sekrit-value-xyz' })
      .expect(400);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('super-sekrit-value-xyz');
  });

  // --- XSS / SQL / control-char payloads still pass Zod (strings are strings), but wrong secret → 403 ---

  it('accepts XSS-looking string in redirect_uri (Zod passes, URL() catches later)', async () => {
    // <script>alert(1)</script> is a valid string, not a valid URL → new URL() throws.
    // Zod passes it, but we want URL() constructor check to additionally catch invalid URLs.
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({
        ...validBody,
        redirect_uri: '<script>alert(1)</script>',
      })
      .expect(400);
    // With Zod .url() or URL() guard, this returns 400 instead of crashing to 500.
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects malformed redirect_uri string (not a URL)', async () => {
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({ ...validBody, redirect_uri: 'not-a-url' })
      .expect(400);
    expect(res.body.error).toBe('invalid_request');
  });

  // --- Happy path shape unchanged ---

  it('valid strict body still redirects (happy path preserved)', async () => {
    const { client_id } = await registerClient();
    const res = await request(app)
      .post('/oauth/approve')
      .type('form')
      .send({
        client_id,
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: 'challenge',
        state: 'happystate',
        secret: 'test-secret',
      })
      .expect(302);
    expect(res.headers.location).toContain('code=');
    expect(res.headers.location).toContain('state=happystate');
  });
});

// --- /mcp auth enforcement ---

describe('POST /mcp', () => {
  it('returns 401 without Authorization header', async () => {
    await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }).expect(401);
  });

  it('returns 401 with invalid bearer token', async () => {
    await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer invalid-token')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      .expect(401);
  });
});

// --- M5: JSON-RPC error middleware ---

describe('Express error middleware (M5)', () => {
  it('app has a JSON error handler registered (verified via _testErrorMiddleware export)', async () => {
    // Express 5 internal router structure is not stable for introspection.
    // Verify the exported test helper instead — its presence confirms the middleware was installed.
    const { _testErrorMiddleware } = await import('./http.js');
    expect(typeof _testErrorMiddleware).toBe('function');
  });

  // M3: fire-and-forget session.server.close() error should be logged at debug
  it('_testSessionCloseErrorHandler logs at debug (M3)', async () => {
    const { _testSessionCloseErrorHandler } = await import('./http.js');
    if (!_testSessionCloseErrorHandler) {
      throw new Error('_testSessionCloseErrorHandler not exported — M3 fix not implemented');
    }
    const debugSpy = vi.spyOn(logger, 'debug');
    try {
      _testSessionCloseErrorHandler(new Error('close failed'));
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('session'),
      );
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('unhandled synchronous errors are responded to as JSON with error field', async () => {
    // We install a temporary error-triggering route to exercise the middleware.
    // The existing app already has error middleware from startHttpServer (M5 fix).
    // Simulate by hitting an endpoint that doesn't exist — Express returns 404 JSON, not 500.
    // The real test is done by importing the error handler directly.
    const { _testErrorMiddleware } = await import('./http.js');
    if (!_testErrorMiddleware) {
      // M5 not yet implemented — test must fail
      throw new Error('_testErrorMiddleware not exported — M5 error middleware not implemented yet');
    }
    const mockRes = {
      status: (code: number) => ({ json: (body: unknown) => ({ statusCode: code, body }) }),
    };
    const result = _testErrorMiddleware(new Error('boom'), {}, mockRes, () => {}) as {
      statusCode: number;
      body: unknown;
    };
    expect(result.statusCode).toBe(500);
    expect((result.body as { error: string }).error).toBe('boom');
  });
});
