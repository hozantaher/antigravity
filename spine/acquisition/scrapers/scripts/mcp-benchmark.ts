import { createMcpClient } from './lib/mcp-client.js';

const BASE_URL = process.env.MCP_URL || 'https://garaaage-scrapers-production.up.railway.app';
const SECRET = process.env.MCP_SECRET || '';

interface TimedResult<T> {
  data: T;
  ms: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
  const start = performance.now();
  const data = await fn();
  return { data, ms: performance.now() - start };
}

// --- MCP Client (reuses shared OAuth implementation) ---

const mcp = createMcpClient({ baseUrl: BASE_URL, secret: SECRET, prefix: 'bench' });

async function authenticate(): Promise<{ authMs: number }> {
  const t0 = performance.now();
  await mcp.listTools(); // triggers OAuth + init
  return { authMs: performance.now() - t0 };
}

async function mcpCall(
  _token: string,
  _sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<TimedResult<unknown>> {
  if (method === 'tools/list') {
    return timed(async () => {
      const tools = await mcp.listTools();
      return { result: { tools } };
    });
  }
  if (method === 'tools/call') {
    return timed(async () => {
      const result = await mcp.callTool(
        `bench__${(params as Record<string, unknown>).name}`,
        ((params as Record<string, unknown>).arguments as Record<string, unknown>) || {},
      );
      return { result };
    });
  }
  return { data: null, ms: 0 };
}

function extractText(result: unknown): string {
  const r = result as { result?: { content?: Array<{ text?: string }> } };
  return r?.result?.content?.[0]?.text || JSON.stringify(r?.result).slice(0, 200);
}

function extractRowCount(result: unknown): number {
  const text = extractText(result);
  try {
    const parsed = JSON.parse(text);
    return parsed.rowCount ?? parsed.rows?.length ?? 0;
  } catch {
    return 0;
  }
}

// --- Benchmark ---

interface BenchmarkResult {
  name: string;
  ms: number;
  rows?: number;
  responseSize?: number;
  error?: string;
}

async function runBenchmarks() {
  console.log(`\n🔧 MCP Performance Benchmark`);
  console.log(`   Server: ${BASE_URL}\n`);

  // Auth
  console.log('Authenticating...');
  const auth = await authenticate();
  console.log(`  OAuth + MCP init: ${auth.authMs.toFixed(0)} ms\n`);

  const token = ''; // handled internally by mcp client
  const sessionId = '';
  const results: BenchmarkResult[] = [{ name: 'OAuth + MCP init', ms: auth.authMs }];

  const queries: Array<{ name: string; method: string; params: Record<string, unknown> }> = [
    {
      name: 'tools/list',
      method: 'tools/list',
      params: {},
    },
    {
      name: 'get_stats (all sources)',
      method: 'tools/call',
      params: { name: 'get_stats', arguments: {} },
    },
    {
      name: 'COUNT(*) judikaty',
      method: 'tools/call',
      params: { name: 'query', arguments: { source: 'judikaty', sql: 'SELECT COUNT(*) as cnt FROM decisions' } },
    },
    {
      name: 'COUNT(*) esbirka',
      method: 'tools/call',
      params: { name: 'query', arguments: { source: 'esbirka', sql: 'SELECT COUNT(*) as cnt FROM acts' } },
    },
    {
      name: 'Simple SELECT (judikaty, 10 rows)',
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          source: 'judikaty',
          sql: "SELECT spisova_znacka, soud, datum_vydani FROM decisions WHERE source = 'nsoud' LIMIT 10",
        },
      },
    },
    {
      name: 'Typesense search (judikaty pravni_veta)',
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          source: 'judikaty',
          table: 'decisions',
          query: 'zprostředkování',
          columns: ['pravni_veta'],
          filter: "source = 'nsoud'",
          limit: 10,
        },
      },
    },
    {
      name: 'Typesense search (esbirka full_text)',
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          source: 'esbirka',
          table: 'acts',
          query: '2445',
          columns: ['full_text'],
          limit: 5,
        },
      },
    },
    {
      name: 'ILIKE search (judikaty pravni_veta)',
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          source: 'judikaty',
          sql: "SELECT spisova_znacka, soud, substr(pravni_veta, 1, 200) as pv FROM decisions WHERE source = 'nsoud' AND pravni_veta ILIKE '%zprostředkov%' LIMIT 10",
        },
      },
    },
    {
      name: 'ILIKE search (esbirka full_text)',
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          source: 'esbirka',
          sql: "SELECT citace, nazev FROM acts WHERE full_text ILIKE '%2445%' AND citace ILIKE '%89/2012%' LIMIT 5",
        },
      },
    },
    {
      name: 'Multi-word search (6 words, OR ranking)',
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          source: 'judikaty',
          table: 'decisions',
          query: 'objektivní odpovědnost provozovatel vozidla překročení rychlosti',
          columns: ['pravni_veta', 'vyrok', 'klicova_slova'],
          limit: 10,
        },
      },
    },
    {
      name: 'Multi-column search (judikaty)',
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          source: 'judikaty',
          table: 'decisions',
          query: 'zprostředkovatelská smlouva',
          columns: ['pravni_veta', 'vyrok', 'klicova_slova', 'oduvodneni'],
          filter: "source = 'nsoud'",
          limit: 10,
        },
      },
    },
    {
      name: 'get_decision (by spisová značka)',
      method: 'tools/call',
      params: {
        name: 'get_decision',
        arguments: { source: 'judikaty', identifier: '33 Cdo 2675/2007', sections: 'metadata' },
      },
    },
    {
      name: 'get_decision (full, with gzip decompress)',
      method: 'tools/call',
      params: {
        name: 'get_decision',
        arguments: { source: 'judikaty', identifier: '33 Cdo 2675/2007', sections: 'all', max_length: 5000 },
      },
    },
    {
      name: 'read_paragraphs (§ 2445-2446 OZ)',
      method: 'tools/call',
      params: {
        name: 'read_paragraphs',
        arguments: { source: 'esbirka', citace: '89/2012 Sb.', paragraphs: ['2445', '2446'] },
      },
    },
    {
      name: 'get_law_context (89/2012 Sb.)',
      method: 'tools/call',
      params: {
        name: 'get_law_context',
        arguments: { source: 'esbirka', citace: '89/2012 Sb.' },
      },
    },
    {
      name: 'get_schema (judikaty)',
      method: 'tools/call',
      params: {
        name: 'get_schema',
        arguments: { source: 'judikaty' },
      },
    },
    {
      name: 'Complex query (judikaty GROUP BY)',
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          source: 'judikaty',
          sql: 'SELECT source, COUNT(*) as cnt, COUNT(pravni_veta) as has_pv FROM decisions GROUP BY source',
        },
      },
    },
    {
      name: 'Large result (judikaty, 100 rows)',
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          source: 'judikaty',
          sql: "SELECT spisova_znacka, soud, datum_vydani, substr(pravni_veta, 1, 300) as pv FROM decisions WHERE source = 'nsoud' AND pravni_veta IS NOT NULL LIMIT 100",
        },
      },
    },
    {
      name: 'substr on full_text (esbirka, 5000 chars)',
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          source: 'esbirka',
          sql: "SELECT substr(full_text, 1, 5000) as text FROM acts WHERE citace = '89/2012 Sb.' LIMIT 1",
        },
      },
    },
  ];

  // Run sequentially
  console.log('Running benchmarks...\n');

  for (const q of queries) {
    try {
      const result = await mcpCall(token, sessionId, q.method, q.params);
      const rows = extractRowCount(result.data);
      const responseSize = JSON.stringify(result.data).length;

      results.push({ name: q.name, ms: result.ms, rows, responseSize });
      console.log(
        `  ✓ ${q.name.padEnd(45)} ${result.ms.toFixed(0).padStart(6)} ms  ${rows > 0 ? `${rows} rows` : ''}  ${(responseSize / 1024).toFixed(1)} KB`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ name: q.name, ms: 0, error: msg });
      console.log(`  ✗ ${q.name.padEnd(45)} ERROR: ${msg}`);
    }
  }

  // Concurrent test
  console.log('\nConcurrent queries (3 parallel)...');
  const concurrentQueries = [
    { name: 'query', arguments: { source: 'judikaty', sql: 'SELECT COUNT(*) as cnt FROM decisions' } },
    { name: 'query', arguments: { source: 'esbirka', sql: 'SELECT COUNT(*) as cnt FROM acts' } },
    { name: 'get_stats', arguments: {} },
  ];

  const concResult = await timed(async () => {
    return Promise.all(concurrentQueries.map((q) => mcpCall(token, sessionId, 'tools/call', q)));
  });

  const maxIndividual = Math.max(...concResult.data.map((r) => r.ms));
  results.push({ name: 'Concurrent (3 parallel)', ms: concResult.ms });
  console.log(
    `  ✓ ${'3 parallel queries'.padEnd(45)} ${concResult.ms.toFixed(0).padStart(6)} ms  (max individual: ${maxIndividual.toFixed(0)} ms)`,
  );

  // Repeated query (warm cache)
  console.log('\nCache test (same query 5x)...');
  const cacheTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await mcpCall(token, sessionId, 'tools/call', {
      name: 'query',
      arguments: { source: 'judikaty', sql: 'SELECT COUNT(*) FROM decisions' },
    });
    cacheTimes.push(r.ms);
  }
  const avg = cacheTimes.reduce((a, b) => a + b, 0) / cacheTimes.length;
  const min = Math.min(...cacheTimes);
  const max = Math.max(...cacheTimes);
  results.push({ name: 'Repeated query (avg of 5)', ms: avg });
  console.log(
    `  ✓ ${'COUNT(*) × 5'.padEnd(45)} avg: ${avg.toFixed(0)} ms  min: ${min.toFixed(0)} ms  max: ${max.toFixed(0)} ms`,
  );

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const queryResults = results.filter((r) => r.name !== 'OAuth + MCP init' && !r.error);
  const totalMs = queryResults.reduce((a, r) => a + r.ms, 0);
  const avgMs = totalMs / queryResults.length;

  console.log(`  Server:              ${BASE_URL}`);
  console.log(`  Auth + init:         ${auth.authMs.toFixed(0)} ms`);
  console.log(`  Queries tested:      ${queryResults.length}`);
  console.log(`  Average latency:     ${avgMs.toFixed(0)} ms`);
  console.log(
    `  Fastest:             ${Math.min(...queryResults.map((r) => r.ms)).toFixed(0)} ms (${queryResults.reduce((a, b) => (a.ms < b.ms ? a : b)).name})`,
  );
  console.log(
    `  Slowest:             ${Math.max(...queryResults.map((r) => r.ms)).toFixed(0)} ms (${queryResults.reduce((a, b) => (a.ms > b.ms ? a : b)).name})`,
  );
  console.log(`  Errors:              ${results.filter((r) => r.error).length}`);
  console.log('='.repeat(70));
}

runBenchmarks().catch((e) => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
