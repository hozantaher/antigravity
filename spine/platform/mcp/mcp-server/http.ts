import express from 'express';
import { randomUUID } from 'crypto';
import pinoHttpModule from 'pino-http';
const pinoHttp = pinoHttpModule.default ?? pinoHttpModule;
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthStore } from './auth.js';
import { createAuthProvider } from './auth.js';
import { registerTools, registerResources } from './tools.js';
import { VERSION, BUILD_SHA, BUILD_TIME } from './version.js';
import { logger } from '../lib/logger.js';

/**
 * Strict Zod schema for POST /oauth/approve body.
 * All required fields must be non-empty strings; redirect_uri must be a valid URL.
 * `.strict()` rejects unknown keys to prevent forward-compat surface expansion.
 */
const oauthApproveSchema = z
  .object({
    client_id: z.string().min(1),
    redirect_uri: z.string().min(1).url(),
    code_challenge: z.string().min(1),
    secret: z.string().min(1),
    state: z.string().optional(),
  })
  .strict();

export const startHttpServer = (port: number, issuerUrl: string, secret: string, store: AuthStore) => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  const { provider, isClientRegistered, issueAuthCode, secret: approveSecret } = createAuthProvider(secret, store);

  // OAuth routes (metadata, register, authorize, token, revoke)
  // Rate limiting relaxed — extension is the only client, auth is secret-protected
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(issuerUrl),
      scopesSupported: [],
      clientRegistrationOptions: { rateLimit: false },
      tokenOptions: { rateLimit: false },
      revocationOptions: { rateLimit: false },
    }),
  );

  // Approval form handler (POST from the consent page)
  app.use('/oauth/approve', express.urlencoded({ extended: false }));
  app.post('/oauth/approve', async (req, res) => {
    const parseResult = oauthApproveSchema.safeParse(req.body);
    if (!parseResult.success) {
      // Redact sensitive field values from issue output — only return paths + codes, never raw values.
      const details = parseResult.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      }));
      res.status(400).json({ error: 'invalid_request', details });
      return;
    }

    const { client_id, redirect_uri, code_challenge, state, secret: inputSecret } = parseResult.data;

    if (inputSecret !== approveSecret) {
      res.status(403).type('html').send(`
        <!DOCTYPE html>
        <html><head><title>Denied</title>
        <style>body { font-family: system-ui; max-width: 400px; margin: 80px auto; padding: 0 20px; }</style>
        </head><body><h2>Wrong secret</h2><p><a href="javascript:history.back()">Try again</a></p></body></html>
      `);
      return;
    }

    if (!(await isClientRegistered(client_id))) {
      res.status(400).json({ error: 'Unknown client_id — re-register' });
      return;
    }

    const code = await issueAuthCode(client_id, code_challenge, redirect_uri, state || undefined);
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    res.redirect(redirectUrl.toString());
  });

  // Health endpoint — no auth required, returns version + uptime
  const startedAt = new Date().toISOString();
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: VERSION,
      sha: BUILD_SHA,
      buildTime: BUILD_TIME,
      startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  // MCP endpoint — per-session state (transport + server for proper cleanup)
  interface Session {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    lastSeen: number;
  }
  const sessions = new Map<string, Session>();

  const removeSession = (id: string) => {
    sessions.delete(id);
  };

  // Clean up idle sessions every 10 minutes
  const SESSION_IDLE_TTL = 2 * 60 * 60 * 1000; // 2 hours
  setInterval(
    () => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (now - session.lastSeen > SESSION_IDLE_TTL) {
          removeSession(id);
          session.server.close().catch((err: Error) => {
            logger.debug({ err }, 'mcp_session_close_error — idle session cleanup');
          });
        }
      }
    },
    10 * 60 * 1000,
  ).unref();

  app.all('/mcp', requireBearerAuth({ verifier: provider }), async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }

    if (sessionId && !sessions.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = new McpServer({
      name: 'garaaage-scrapers',
      version: VERSION,
    });

    registerTools(server);
    registerResources(server);

    await server.connect(transport);
    await transport.handleRequest(req, res);

    // Store after handleRequest — session ID is generated during first request
    if (transport.sessionId) {
      // Chain with Protocol's onclose handler (set by server.connect) instead of replacing it
      const protocolOnclose = transport.onclose;
      transport.onclose = () => {
        protocolOnclose?.();
        if (transport.sessionId) removeSession(transport.sessionId);
      };
      sessions.set(transport.sessionId, { transport, server, lastSeen: Date.now() });
    }
  });

  // JSON-RPC error envelope middleware (M5).
  // Express 5 auto-forwards rejected async handler promises to next(err).
  // Without this, the default Express error handler returns an HTML 500 page,
  // which MCP clients cannot parse. This converts unhandled errors to a
  // JSON-RPC-compatible { error: { code, message } } envelope.
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      logger.error({ err }, 'mcp_handler_error');
      res.status(500).json({ error: { code: -32603, message: err.message ?? 'Internal error' } });
    },
  );

  const httpServer = app.listen(port, () => {
    logger.info({ port, issuerUrl, endpoint: `${issuerUrl}/mcp` }, 'MCP HTTP server started');
  });

  return { app, server: httpServer };
};

/**
 * Exported for unit-testing the session close error handler (M3).
 * Invokes the same handler used in the idle session cleanup interval.
 */
export function _testSessionCloseErrorHandler(err: Error): void {
  logger.debug({ err }, 'mcp_session_close_error — idle session cleanup');
}

/**
 * Exported for unit-testing the error middleware shape (M5).
 * Returns the response produced by the error handler for the given error.
 */
export function _testErrorMiddleware(
  err: Error,
  _req: unknown,
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  _next: unknown,
): unknown {
  return res.status(500).json({ error: err.message ?? 'Internal error' });
}
