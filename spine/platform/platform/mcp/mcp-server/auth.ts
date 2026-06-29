import { randomBytes, randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const AUTH_CODE_TTL_SEC = 5 * 60; // 5 minutes
const CLIENT_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

// Key prefixes
const KEY = {
  client: (id: string) => `oauth:client:${id}`,
  code: (code: string) => `oauth:code:${code}`,
  token: (token: string) => `oauth:token:${token}`,
} as const;

export interface AuthStore {
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  setClient(clientId: string, client: OAuthClientInformationFull): Promise<void>;
  getCode(
    code: string,
  ): Promise<{ clientId: string; codeChallenge: string; redirectUri: string; state?: string } | undefined>;
  setCode(
    code: string,
    data: { clientId: string; codeChallenge: string; redirectUri: string; state?: string },
  ): Promise<void>;
  deleteCode(code: string): Promise<void>;
  getToken(token: string): Promise<{ clientId: string; token: string; expiresAt: number } | undefined>;
  setToken(token: string, data: { clientId: string; token: string; expiresAt: number }): Promise<void>;
  deleteToken(token: string): Promise<void>;
  hasClient(clientId: string): Promise<boolean>;
}

// --- Redis-backed store ---

export function createRedisStore(redis: Redis): AuthStore {
  return {
    async getClient(clientId) {
      const data = await redis.get(KEY.client(clientId));
      return data ? JSON.parse(data) : undefined;
    },
    async setClient(clientId, client) {
      await redis.set(KEY.client(clientId), JSON.stringify(client), 'EX', CLIENT_TTL_SEC);
    },
    async getCode(code) {
      const data = await redis.get(KEY.code(code));
      return data ? JSON.parse(data) : undefined;
    },
    async setCode(code, data) {
      await redis.set(KEY.code(code), JSON.stringify(data), 'EX', AUTH_CODE_TTL_SEC);
    },
    async deleteCode(code) {
      await redis.del(KEY.code(code));
    },
    async getToken(token) {
      const data = await redis.get(KEY.token(token));
      return data ? JSON.parse(data) : undefined;
    },
    async setToken(token, data) {
      await redis.set(KEY.token(token), JSON.stringify(data), 'EX', TOKEN_TTL_SEC);
    },
    async deleteToken(token) {
      await redis.del(KEY.token(token));
    },
    async hasClient(clientId) {
      return (await redis.exists(KEY.client(clientId))) === 1;
    },
  };
}

// --- In-memory store (for tests and fallback) ---

export function createMemoryStore(): AuthStore {
  const clients = new Map<string, OAuthClientInformationFull>();
  const codes = new Map<
    string,
    { clientId: string; codeChallenge: string; redirectUri: string; state?: string; createdAt: number }
  >();
  const tokens = new Map<string, { clientId: string; token: string; expiresAt: number }>();

  return {
    async getClient(clientId) {
      return clients.get(clientId);
    },
    async setClient(clientId, client) {
      clients.set(clientId, client);
    },
    async getCode(code) {
      const entry = codes.get(code);
      if (!entry) return undefined;
      if (Date.now() - entry.createdAt > AUTH_CODE_TTL_SEC * 1000) {
        codes.delete(code);
        return undefined;
      }
      return entry;
    },
    async setCode(code, data) {
      codes.set(code, { ...data, createdAt: Date.now() });
    },
    async deleteCode(code) {
      codes.delete(code);
    },
    async getToken(token) {
      return tokens.get(token);
    },
    async setToken(token, data: { clientId: string; token: string; expiresAt: number }) {
      tokens.set(token, data);
    },
    async deleteToken(token) {
      tokens.delete(token);
    },
    async hasClient(clientId) {
      return clients.has(clientId);
    },
  };
}

// --- OAuth provider + helpers (store-agnostic) ---

export const createAuthProvider = (secret: string, store: AuthStore) => {
  const BRAND_LABEL = process.env.BRAND_LABEL || 'Garaaage';

  const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(clientId: string) {
      return store.getClient(clientId);
    },
    async registerClient(clientInfo) {
      const clientId = randomUUID();
      const client: OAuthClientInformationFull = {
        ...clientInfo,
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret: randomBytes(32).toString('hex'),
        client_secret_expires_at: 0,
      };
      await store.setClient(clientId, client);
      return client;
    },
  };

  const isClientRegistered = (clientId: string) => store.hasClient(clientId);

  const issueAuthCode = async (
    clientId: string,
    codeChallenge: string,
    redirectUri: string,
    state?: string,
  ): Promise<string> => {
    const code = randomBytes(32).toString('hex');
    await store.setCode(code, { clientId, codeChallenge, redirectUri, state });
    return code;
  };

  const provider: OAuthServerProvider = {
    get clientsStore() {
      return clientsStore;
    },

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
      const html = `<!DOCTYPE html>
<html><head><title>${BRAND_LABEL} MCP - Authorize</title>
<style>
  body { font-family: system-ui; max-width: 400px; margin: 80px auto; padding: 0 20px; }
  input, button { display: block; width: 100%; padding: 10px; margin: 8px 0; box-sizing: border-box; }
  button { background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; }
  button:hover { background: #1d4ed8; }
</style></head>
<body>
  <h2>${BRAND_LABEL} MCP</h2>
  <p>Client <strong>${escapeHtml(String(client.client_name || client.client_id))}</strong> requests access.</p>
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="client_id" value="${escapeHtml(client.client_id)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
    <input type="hidden" name="state" value="${escapeHtml(params.state || '')}">
    <input type="password" name="secret" placeholder="Enter secret" required autofocus>
    <button type="submit">Approve</button>
  </form>
</body></html>`;
      res.type('html').send(html);
    },

    async challengeForAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<string> {
      const entry = await store.getCode(authorizationCode);
      if (!entry) throw new Error('Invalid authorization code');
      return entry.codeChallenge;
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<OAuthTokens> {
      const entry = await store.getCode(authorizationCode);
      if (!entry || entry.clientId !== client.client_id) {
        throw new Error('Invalid authorization code');
      }
      await store.deleteCode(authorizationCode);

      const token = randomBytes(48).toString('hex');
      const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
      await store.setToken(token, { clientId: client.client_id, token, expiresAt });

      return {
        access_token: token,
        token_type: 'bearer',
      };
    },

    async exchangeRefreshToken(): Promise<OAuthTokens> {
      throw new Error('Refresh tokens not supported — access tokens never expire');
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const entry = await store.getToken(token);
      if (!entry) throw new InvalidTokenError('Invalid access token');
      return {
        token: entry.token,
        clientId: entry.clientId,
        scopes: [],
        expiresAt: entry.expiresAt,
      };
    },

    async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
      await store.deleteToken(request.token);
    },
  };

  return { provider, isClientRegistered, issueAuthCode, secret };
};
