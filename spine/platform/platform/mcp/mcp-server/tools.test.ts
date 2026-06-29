import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDatabase } from './test-utils.js';
import { registerTools, registerResources, _setTestSources } from './tools.js';

const { esbirkaSource, judikatySource } = createTestDatabase();
_setTestSources(
  new Map([
    ['esbirka', esbirkaSource],
    ['judikaty', judikatySource],
  ]),
);

let client: InstanceType<typeof Client>;
let server: McpServer;

async function callTool(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

beforeAll(async () => {
  server = new McpServer({ name: 'test', version: '1.0.0' });
  registerTools(server);
  registerResources(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

// --- query tool ---

describe('query tool', () => {
  it('returns JSON result for valid SELECT', async () => {
    const result = await callTool('query', { source: 'esbirka', sql: 'SELECT citace, nazev FROM acts' });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.columns).toContain('citace');
  });

  it('returns SQL error for invalid query', async () => {
    const result = await callTool('query', { source: 'esbirka', sql: 'SELECT * FROM nonexistent_table' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('SQL error');
  });

  it('respects limit parameter', async () => {
    const result = await callTool('query', { source: 'esbirka', sql: 'SELECT * FROM acts', limit: 1 });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.rowCount).toBe(1);
  });

  it('returns error for unknown source', async () => {
    const result = await callTool('query', { source: 'unknown', sql: 'SELECT 1' });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('Unknown source');
  });
});

// --- read_paragraphs tool ---

describe('read_paragraphs tool', () => {
  it('extracts paragraphs with header', async () => {
    const result = await callTool('read_paragraphs', {
      source: 'esbirka',
      citace: '89/2012 Sb.',
      paragraphs: ['2445', '2446'],
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as any)[0].text;
    expect(text).toContain('89/2012 Sb.');
    expect(text).toContain('§ 2445');
    expect(text).toContain('Zákon občanský zákoník');
  });

  it('reports missing paragraphs', async () => {
    const result = await callTool('read_paragraphs', {
      source: 'esbirka',
      citace: '89/2012 Sb.',
      paragraphs: ['9999'],
    });
    const text = (result.content as any)[0].text;
    expect(text).toContain('No paragraphs found');
  });
});

// --- search tool ---

describe('search tool', () => {
  it('returns ILIKE results with rowCount', async () => {
    const result = await callTool('search', {
      source: 'judikaty',
      table: 'decisions',
      query: 'zprostředkov',
      columns: ['pravni_veta'],
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.rowCount).toBeGreaterThan(0);
  });

  it('includes warning for malformed filter', async () => {
    const result = await callTool('search', {
      source: 'judikaty',
      table: 'decisions',
      query: 'test',
      columns: ['pravni_veta'],
      filter: 'source = nsoud',
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.warning).toContain('ignored');
  });
});

// --- get_law_context tool ---

describe('get_law_context tool', () => {
  it('returns law metadata', async () => {
    const result = await callTool('get_law_context', { source: 'esbirka', citace: '89/2012 Sb.' });
    expect(result.isError).toBeFalsy();
    const text = (result.content as any)[0].text;
    expect(text).toContain('Zákon občanský zákoník');
    expect(text).toContain('MENI');
  });

  it('returns message for unknown law', async () => {
    const result = await callTool('get_law_context', { source: 'esbirka', citace: 'NOPE/0000 Sb.' });
    const text = (result.content as any)[0].text;
    expect(text).toContain('nenalezen');
  });
});

// --- get_decision tool ---

describe('get_decision tool', () => {
  it('returns formatted decision', async () => {
    const result = await callTool('get_decision', { source: 'judikaty', identifier: 'I.ÚS 52/25' });
    expect(result.isError).toBeFalsy();
    const text = (result.content as any)[0].text;
    expect(text).toContain('Ústavní soud');
  });

  it('returns message for unknown decision', async () => {
    const result = await callTool('get_decision', { source: 'judikaty', identifier: 'XXXXX/9999' });
    const text = (result.content as any)[0].text;
    expect(text).toContain('nenalezeno');
  });
});

// --- get_stats tool ---

describe('get_stats tool', () => {
  it('returns stats for specific source', async () => {
    const result = await callTool('get_stats', { source: 'judikaty' });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed[0].source).toBe('judikaty');
    expect(parsed[0].decisions).toBeDefined();
  });

  it('returns stats for all sources when omitted', async () => {
    const result = await callTool('get_stats', {});
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.length).toBeGreaterThan(0);
  });
});

// --- get_schema tool ---

describe('get_schema tool', () => {
  it('returns schema statements', async () => {
    const result = await callTool('get_schema', { source: 'esbirka' });
    expect(result.isError).toBeFalsy();
    const text = (result.content as any)[0].text;
    expect(text).toContain('esbirka_acts');
  });
});

// --- Resources ---

describe('resources', () => {
  it('lists sources resource', async () => {
    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toContain('garaaage://sources');
  });
});
