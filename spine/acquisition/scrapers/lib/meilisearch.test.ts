import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientCtor } = vi.hoisted(() => ({
  clientCtor: vi.fn().mockImplementation(function Client(this: any, cfg: unknown) {
    this.cfg = cfg;
  }),
}));

vi.mock('typesense', () => ({
  default: {
    Client: clientCtor,
  },
}));

import {
  SEARCH_INDEXES,
  createSearchClient,
  getPgSelectColumns,
  hasSearchIndex,
} from './meilisearch';

describe('meilisearch/typesense config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TYPESENSE_URL;
    delete process.env.TYPESENSE_API_KEY;
    delete process.env.MEILI_URL;
    delete process.env.MEILI_API_KEY;
  });

  it('returns unique PG select columns from fields + compressed columns', () => {
    const config = SEARCH_INDEXES.judikaty_decisions;
    const cols = getPgSelectColumns(config);

    expect(cols).toContain('oduvodneni');
    expect(cols.filter((c) => c === 'oduvodneni')).toHaveLength(1);
    expect(cols).toContain('pravni_veta');
  });

  it('detects whether prefixed table has search index config', () => {
    expect(hasSearchIndex('judikaty_decisions')).toBe(true);
    expect(hasSearchIndex('unknown_table')).toBe(false);
  });

  it('returns null when search client env is not configured', () => {
    expect(createSearchClient()).toBeNull();
    expect(clientCtor).not.toHaveBeenCalled();
  });

  it('creates client from TYPESENSE env using explicit port', () => {
    process.env.TYPESENSE_URL = 'https://search.example.com:8443';
    process.env.TYPESENSE_API_KEY = 'secret-key';

    const client = createSearchClient();
    expect(client).toBeTruthy();
    expect(clientCtor).toHaveBeenCalledTimes(1);
    expect(clientCtor).toHaveBeenCalledWith({
      nodes: [
        {
          host: 'search.example.com',
          port: 8443,
          protocol: 'https',
        },
      ],
      apiKey: 'secret-key',
      connectionTimeoutSeconds: 60,
    });
  });

  it('uses fallback MEILI env and default port mapping', () => {
    const fallbackApiKey = ['fallback', 'key'].join('-');
    process.env.MEILI_URL = 'http://127.0.0.1';
    process.env.MEILI_API_KEY = fallbackApiKey;

    const client = createSearchClient();
    expect(client).toBeTruthy();
    expect(clientCtor).toHaveBeenCalledTimes(1);
    expect(clientCtor).toHaveBeenCalledWith({
      nodes: [
        {
          host: '127.0.0.1',
          port: 8108,
          protocol: 'http',
        },
      ],
      apiKey: fallbackApiKey,
      connectionTimeoutSeconds: 60,
    });
  });

  it('defaults https port to 443 when URL has no explicit port', () => {
    process.env.TYPESENSE_URL = 'https://search.example.com';
    process.env.TYPESENSE_API_KEY = 'https-key';

    const client = createSearchClient();
    expect(client).toBeTruthy();
    expect(clientCtor).toHaveBeenCalledTimes(1);
    expect(clientCtor).toHaveBeenCalledWith({
      nodes: [
        {
          host: 'search.example.com',
          port: 443,
          protocol: 'https',
        },
      ],
      apiKey: 'https-key',
      connectionTimeoutSeconds: 60,
    });
  });
});
