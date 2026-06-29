import { createHash, randomBytes } from 'crypto';

/**
 * Default fetch timeout for all MCP client HTTP calls. Mirrors `lib/fetch.ts`.
 * Prevents indefinite hangs if the MCP server stops responding mid-handshake.
 */
export const FETCH_TIMEOUT_MS = 30_000;

/** Convenience: attach AbortSignal.timeout() to a fetch init object. */
const withTimeout = (init?: RequestInit): RequestInit => ({
  ...(init ?? {}),
  signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
});

export class McpRequestError extends Error {
  constructor(public readonly status: number, prefix: string) {
    super(`[${prefix}] MCP request failed: ${status}`);
  }
}

interface McpClientConfig {
  baseUrl: string;
  secret?: string;
  prefix: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface OAuthMetadata {
  registration_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

interface OAuthClient {
  client_id: string;
  client_secret: string;
}

const generatePkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

export const createMcpClient = (config: McpClientConfig) => {
  const { baseUrl, secret, prefix } = config;

  let token: string | null = null;
  let sessionId: string | null = null;
  let jsonRpcId = 0;
  let oauthMetadata: OAuthMetadata | null = null;
  let oauthClient: OAuthClient | null = null;
  const useOAuth = !!secret;

  const rewriteOrigin = (url: string): string => {
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    return parsed.toString();
  };

  const fetchMetadata = async (): Promise<OAuthMetadata> => {
    if (oauthMetadata) return oauthMetadata;
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, withTimeout());
    if (!res.ok) throw new Error(`[${prefix}] OAuth metadata fetch failed: ${res.status}`);
    const raw = (await res.json()) as OAuthMetadata;
    // Rewrite endpoint origins to use baseUrl — ensures internal networking
    // works when baseUrl differs from the server's MCP_ISSUER_URL.
    oauthMetadata = {
      registration_endpoint: rewriteOrigin(raw.registration_endpoint),
      authorization_endpoint: rewriteOrigin(raw.authorization_endpoint),
      token_endpoint: rewriteOrigin(raw.token_endpoint),
    };
    return oauthMetadata;
  };

  const registerClient = async (): Promise<OAuthClient> => {
    if (oauthClient) return oauthClient;
    const meta = await fetchMetadata();
    const res = await fetch(
      meta.registration_endpoint,
      withTimeout({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: `garaaage-terms-${prefix}`,
          redirect_uris: ['http://localhost:9999/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      }),
    );
    if (!res.ok) throw new Error(`[${prefix}] OAuth client registration failed: ${res.status}`);
    oauthClient = (await res.json()) as OAuthClient;
    return oauthClient;
  };

  const acquireToken = async (): Promise<string | null> => {
    if (!useOAuth) return null;
    if (token) return token;

    const meta = await fetchMetadata();
    const client = await registerClient();
    const { verifier, challenge } = generatePkce();
    const redirectUri = 'http://localhost:9999/callback';

    const approveRes = await fetch(
      `${baseUrl}/oauth/approve`,
      withTimeout({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          state: 'terms',
          secret: secret!,
        }).toString(),
        redirect: 'manual',
      }),
    );

    const location = approveRes.headers.get('location');
    if (!location) throw new Error(`[${prefix}] OAuth approve did not redirect`);
    const code = new URL(location).searchParams.get('code');
    if (!code) throw new Error(`[${prefix}] No auth code in redirect`);

    const tokenRes = await fetch(
      meta.token_endpoint,
      withTimeout({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: client.client_id,
          client_secret: client.client_secret,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }).toString(),
      }),
    );
    if (!tokenRes.ok) throw new Error(`[${prefix}] OAuth token exchange failed: ${tokenRes.status}`);

    const data = (await tokenRes.json()) as { access_token: string };
    token = data.access_token;
    return token;
  };

  const rpc = async (method: string, params: Record<string, unknown> = {}, retryCount = 0): Promise<unknown> => {
    const t = await acquireToken();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (t) headers['Authorization'] = `Bearer ${t}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const res = await fetch(
      `${baseUrl}/mcp`,
      withTimeout({
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++jsonRpcId,
          method,
          params,
        }),
      }),
    );

    if (!res.ok) {
      if (res.status === 401 && retryCount < 1) {
        token = null;
        sessionId = null;
        initPromise = null;
        return rpc(method, params, retryCount + 1);
      }
      throw new McpRequestError(res.status, prefix);
    }

    const newSession = res.headers.get('mcp-session-id');
    if (newSession) sessionId = newSession;

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      let lastData = '';
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) lastData = line.slice(6);
      }
      return lastData ? JSON.parse(lastData) : null;
    }

    return res.json();
  };

  let initPromise: Promise<void> | null = null;

  const initialize = async () => {
    await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: `garaaage-terms-${prefix}`, version: '1.0.0' },
    });

    const t = await acquireToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (t) headers['Authorization'] = `Bearer ${t}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;

    await fetch(
      `${baseUrl}/mcp`,
      withTimeout({
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
    );
  };

  const ensureInitialized = async () => {
    if (!initPromise) initPromise = initialize();
    return initPromise;
  };

  return {
    prefix,

    async listTools(): Promise<McpTool[]> {
      await ensureInitialized();
      const response = (await rpc('tools/list')) as {
        result?: { tools: McpTool[] };
        error?: { code: number; message: string };
      };
      if (response.error) throw new Error(`[${prefix}] tools/list: ${response.error.message}`);
      return (response.result?.tools ?? []).map((t) => ({
        ...t,
        name: `${prefix}__${t.name}`,
        description: `[${prefix}] ${t.description || ''}`,
      }));
    },

    async callTool(prefixedName: string, args: Record<string, unknown>): Promise<McpToolResult> {
      await ensureInitialized();
      const name = prefixedName.replace(`${prefix}__`, '');
      const response = (await rpc('tools/call', { name, arguments: args })) as {
        result?: McpToolResult;
        error?: { code: number; message: string };
      };
      if (response.error) throw new Error(`[${prefix}] tools/call ${name}: ${response.error.message}`);
      return response.result!;
    },
  };
};

export type McpClient = ReturnType<typeof createMcpClient>;
