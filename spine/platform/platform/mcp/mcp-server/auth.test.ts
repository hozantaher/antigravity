import { describe, it, expect, vi } from 'vitest';
import { createAuthProvider, createMemoryStore } from './auth.js';

// Fresh provider + store for each test to avoid cross-test state leaks
function setup() {
  const store = createMemoryStore();
  const { provider, issueAuthCode, isClientRegistered, secret } = createAuthProvider('test-secret', store);
  return { provider, issueAuthCode, isClientRegistered, secret };
}

// Minimal mock Response for authorize()
function mockResponse() {
  let sentHtml = '';
  let sentType = '';
  return {
    type(t: string) {
      sentType = t;
      return this;
    },
    send(body: string) {
      sentHtml = body;
    },
    get html() {
      return sentHtml;
    },
    get contentType() {
      return sentType;
    },
  };
}

describe('createAuthProvider', () => {
  it('returns provider and secret', () => {
    const { provider, secret } = setup();
    expect(provider).toBeDefined();
    expect(provider.clientsStore).toBeDefined();
    expect(secret).toBe('test-secret');
  });
});

describe('clientsStore', () => {
  it('registerClient generates client_id and client_secret', async () => {
    const { provider } = setup();
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: ['http://localhost/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    } as any);

    expect(client.client_id).toBeDefined();
    expect(client.client_secret).toBeDefined();
    expect(typeof client.client_id).toBe('string');
    expect(client.client_secret!.length).toBeGreaterThan(0);
    expect(client.client_id_issued_at).toBeGreaterThan(0);
    expect(client.client_secret_expires_at).toBe(0);
  });

  it('getClient returns registered client', async () => {
    const { provider } = setup();
    const registered = await provider.clientsStore.registerClient!({
      redirect_uris: ['http://localhost/callback'],
    } as any);

    const found = await provider.clientsStore.getClient!(registered.client_id);
    expect(found).toBeDefined();
    expect(found!.client_id).toBe(registered.client_id);
  });

  it('getClient returns undefined for unknown id', async () => {
    const { provider } = setup();
    const found = await provider.clientsStore.getClient!('nonexistent');
    expect(found).toBeUndefined();
  });
});

describe('issueAuthCode', () => {
  it('returns a hex string', async () => {
    const { issueAuthCode } = setup();
    const code = await issueAuthCode('client-1', 'challenge', 'http://localhost/callback');
    expect(code).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isClientRegistered', () => {
  it('returns true for registered client', async () => {
    const { provider, isClientRegistered } = setup();
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: ['http://localhost/callback'],
    } as any);
    expect(await isClientRegistered(client.client_id)).toBe(true);
  });

  it('returns false for unknown client', async () => {
    const { isClientRegistered } = setup();
    expect(await isClientRegistered('nonexistent')).toBe(false);
  });
});

describe('authorize', () => {
  it('sends HTML consent page', async () => {
    const { provider } = setup();
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ['http://localhost/callback'] } as any);
    const res = mockResponse();

    await provider.authorize(
      client,
      {
        redirectUri: 'http://localhost/callback',
        codeChallenge: 'test-challenge',
        state: 'test-state',
      } as any,
      res as any,
    );

    expect(res.contentType).toBe('html');
    expect(res.html).toContain('Garaaage MCP');
    expect(res.html).toContain(client.client_id);
  });

  it('escapes client_name in HTML to prevent XSS', async () => {
    const { provider } = setup();
    const client = await provider.clientsStore.registerClient!({
      client_name: '<script>alert("xss")</script>',
      redirect_uris: ['http://localhost/callback'],
    } as any);
    const res = mockResponse();

    await provider.authorize(
      client,
      {
        redirectUri: 'http://localhost/callback',
        codeChallenge: 'c',
      } as any,
      res as any,
    );

    expect(res.html).not.toContain('<script>');
    expect(res.html).toContain('&lt;script&gt;');
  });
});

describe('challengeForAuthorizationCode', () => {
  it('returns challenge for valid code', async () => {
    const { provider, issueAuthCode } = setup();
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ['http://localhost/callback'] } as any);
    const code = await issueAuthCode(client.client_id, 'my-challenge', 'http://localhost/callback');

    const challenge = await provider.challengeForAuthorizationCode!(client, code);
    expect(challenge).toBe('my-challenge');
  });

  it('throws for invalid code', async () => {
    const { provider } = setup();
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ['http://localhost/callback'] } as any);

    await expect(provider.challengeForAuthorizationCode!(client, 'bad-code')).rejects.toThrow(
      'Invalid authorization code',
    );
  });

  it('throws for expired code', async () => {
    const { provider, issueAuthCode } = setup();
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ['http://localhost/callback'] } as any);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValueOnce(now);
    const code = await issueAuthCode(client.client_id, 'challenge', 'http://localhost/callback');

    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 1000);
    await expect(provider.challengeForAuthorizationCode!(client, code)).rejects.toThrow('Invalid authorization code');
    vi.restoreAllMocks();
  });
});

describe('exchangeAuthorizationCode', () => {
  it('returns access token and deletes code', async () => {
    const { provider, issueAuthCode } = setup();
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ['http://localhost/callback'] } as any);
    const code = await issueAuthCode(client.client_id, 'challenge', 'http://localhost/callback');

    const tokens = await provider.exchangeAuthorizationCode!(client, code);
    expect(tokens.access_token).toBeDefined();
    expect(tokens.access_token.length).toBeGreaterThan(0);
    expect(tokens.token_type).toBe('bearer');

    // Code should be consumed — second exchange fails
    await expect(provider.exchangeAuthorizationCode!(client, code)).rejects.toThrow('Invalid');
  });

  it('throws for wrong client_id', async () => {
    const { provider, issueAuthCode } = setup();
    const client1 = await provider.clientsStore.registerClient!({
      redirect_uris: ['http://localhost/callback'],
    } as any);
    const client2 = await provider.clientsStore.registerClient!({
      redirect_uris: ['http://localhost/callback'],
    } as any);
    const code = await issueAuthCode(client1.client_id, 'challenge', 'http://localhost/callback');

    await expect(provider.exchangeAuthorizationCode!(client2, code)).rejects.toThrow('Invalid');
  });
});

describe('exchangeRefreshToken', () => {
  it('throws — not supported', async () => {
    const { provider } = setup();
    await expect(provider.exchangeRefreshToken!({} as any, {} as any)).rejects.toThrow('not supported');
  });
});

describe('verifyAccessToken', () => {
  it('returns AuthInfo for valid token', async () => {
    const { provider, issueAuthCode } = setup();
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ['http://localhost/callback'] } as any);
    const code = await issueAuthCode(client.client_id, 'challenge', 'http://localhost/callback');
    const tokens = await provider.exchangeAuthorizationCode!(client, code);

    const authInfo = await provider.verifyAccessToken!(tokens.access_token);
    expect(authInfo.clientId).toBe(client.client_id);
    expect(authInfo.scopes).toEqual([]);
  });

  it('throws for invalid token', async () => {
    const { provider } = setup();
    await expect(provider.verifyAccessToken!('bad-token')).rejects.toThrow('Invalid access token');
  });
});

describe('revokeToken', () => {
  it('removes token so verify fails afterwards', async () => {
    const { provider, issueAuthCode } = setup();
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ['http://localhost/callback'] } as any);
    const code = await issueAuthCode(client.client_id, 'challenge', 'http://localhost/callback');
    const tokens = await provider.exchangeAuthorizationCode!(client, code);

    await expect(provider.verifyAccessToken!(tokens.access_token)).resolves.toBeDefined();
    await provider.revokeToken!(client, { token: tokens.access_token } as any);
    await expect(provider.verifyAccessToken!(tokens.access_token)).rejects.toThrow('Invalid');
  });
});
