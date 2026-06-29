import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import {
  discoverSources,
  executeQuery,
  extractParagraphs,
  ftsSearch,
  getDecision,
  getLawContext,
  getSchema,
  getStats,
  type SourceInfo,
} from './db.js';

// Lazy-initialized sources — resolved on first use
let sourcesPromise: Promise<Map<string, SourceInfo>> | null = null;
let cachedSources: Map<string, SourceInfo> | null = null;

function sourceNames(): string[] {
  return cachedSources ? [...cachedSources.keys()] : [];
}

async function getSources(): Promise<Map<string, SourceInfo>> {
  if (cachedSources) return cachedSources;
  if (!sourcesPromise) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      logger.fatal('DATABASE_URL environment variable is required');
      process.exit(1);
    }
    sourcesPromise = discoverSources(databaseUrl);
  }
  cachedSources = await sourcesPromise;
  if (sourceNames().length === 0) {
    logger.fatal('No sources found in database');
    process.exit(1);
  }
  return cachedSources;
}

/** Initialize sources eagerly — call during server startup. */
export async function initSources(): Promise<string[]> {
  await getSources();
  return sourceNames();
}

/** For testing: inject mock sources. */
export function _setTestSources(sources: Map<string, SourceInfo>) {
  cachedSources = sources;
}

export const registerResources = (server: McpServer) => {
  server.resource('sources', 'garaaage://sources', async () => {
    const sources = await getSources();
    const allStats = await Promise.all(sourceNames().map((name) => getStats(sources.get(name)!)));
    return {
      contents: [
        {
          uri: 'garaaage://sources',
          mimeType: 'application/json',
          text: JSON.stringify(allStats, null, 2),
        },
      ],
    };
  });

  // Schema resources are registered lazily when sources are known
  // We register a parameterized resource that handles any source
  server.resource('schema', 'garaaage://schema/{source}', async (uri) => {
    const sources = await getSources();
    const sourceName = uri.pathname?.split('/').pop() || '';
    const src = sources.get(sourceName);
    if (!src) {
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Unknown source: ${sourceName}` }] };
    }
    const schema = await getSchema(src);
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: schema }] };
  });
};

export const registerTools = (server: McpServer) => {
  server.tool(
    'query',
    `Execute a read-only SQL query against a scraper database. ` +
      `Use unprefixed table names (e.g. 'decisions', 'acts', 'listings') — they are resolved automatically based on the source. ` +
      `Columns matching raw_* are large blobs excluded by default — set include_raw=true to retrieve them (limit capped to 5). ` +
      `Response is capped at 100KB. Use COUNT/GROUP BY for aggregations on large tables.`,
    {
      source: z
        .string()
        .describe('Database source to query (e.g. judikaty, esbirka, autoline, mascus, mobile-de, firmy-cz)'),
      sql: z.string().describe('SQL SELECT query to execute'),
      limit: z.number().int().min(1).max(1000).optional().default(100),
      include_raw: z.boolean().optional().default(false),
    },
    async ({ source, sql, limit, include_raw }) => {
      const sources = await getSources();
      const src = sources.get(source);
      if (!src) {
        return {
          content: [
            { type: 'text' as const, text: `Unknown source: ${source}. Available: ${sourceNames().join(', ')}` },
          ],
          isError: true,
        };
      }
      try {
        const result = await executeQuery(src, { sql, limit, includeRaw: include_raw });
        const output: Record<string, unknown> = {
          rowCount: result.rowCount,
          columns: result.columns,
          rows: result.rows,
        };
        if (result.truncated) {
          output.truncated = true;
          output.truncationReason = result.truncationReason;
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `SQL error: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'read_paragraphs',
    `Extract specific paragraphs (§§) from a Czech law's full text. Only works with 'esbirka' source.`,
    {
      source: z.literal('esbirka'),
      citace: z.string().describe("Law citation, e.g. '89/2012 Sb.'"),
      paragraphs: z.array(z.string()).describe("Paragraph numbers, e.g. ['2445', '2446']"),
    },
    async ({ source, citace, paragraphs }) => {
      const sources = await getSources();
      const src = sources.get(source);
      if (!src) return { content: [{ type: 'text' as const, text: `Unknown source: ${source}` }], isError: true };
      try {
        const result = await extractParagraphs(src, citace, paragraphs);
        if (result.found.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No paragraphs found for ${citace}. Missing: ${result.missing.join(', ')}`,
              },
            ],
          };
        }
        const text = result.found.map((p) => `${p.paragraph}\n${p.text}`).join('\n\n---\n\n');
        const footer = result.missing.length > 0 ? `\n\n[Missing: ${result.missing.join(', ')}]` : '';
        const header = result.nazev ? `# ${citace} — ${result.nazev}` : `# ${citace}`;
        return { content: [{ type: 'text' as const, text: `${header}\n\n${text}${footer}` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'search',
    `Full-text search across a database with matching fragments and metadata. ` +
      `Uses Typesense (fast, typo-tolerant) for judikaty and esbirka; ILIKE fallback for others. ` +
      `Use unprefixed table names (e.g. 'decisions', 'acts', 'listings', 'businesses'). ` +
      `For judikaty: columns include pravni_veta, klicova_slova, vyrok, oduvodneni. For esbirka: nazev, citace, full_text.`,
    {
      source: z.string().describe('Database source to search'),
      table: z.string().describe("Table to search, e.g. 'decisions', 'acts'"),
      query: z.string().describe('Search query — words are matched with ILIKE'),
      columns: z.array(z.string()).describe("Columns to search, e.g. ['pravni_veta', 'klicova_slova']"),
      filter: z.string().optional().describe('SQL filter, e.g. "source = \'nsoud\'"'),
      limit: z.number().int().min(1).max(100).optional().default(20),
    },
    async ({ source, table, query, columns, filter, limit }) => {
      const sources = await getSources();
      const src = sources.get(source);
      if (!src)
        return {
          content: [
            { type: 'text' as const, text: `Unknown source: ${source}. Available: ${sourceNames().join(', ')}` },
          ],
          isError: true,
        };
      try {
        const result = await ftsSearch(src, table, query, columns, limit, filter);
        const output: Record<string, unknown> = { rowCount: result.rowCount, rows: result.rows };
        if (result.engine) output.engine = result.engine;
        if (result.warning) output.warning = result.warning;
        return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Search error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'get_law_context',
    `Get metadata about a Czech law: title, validity, amendments, related laws. Only 'esbirka' source.`,
    {
      source: z.literal('esbirka'),
      citace: z.string().describe("Law citation, e.g. '89/2012 Sb.'"),
    },
    async ({ source, citace }) => {
      const sources = await getSources();
      const src = sources.get(source);
      if (!src) return { content: [{ type: 'text' as const, text: `Unknown source: ${source}` }], isError: true };
      try {
        const text = await getLawContext(src, citace);
        if (!text) return { content: [{ type: 'text' as const, text: `Zákon ${citace} nenalezen.` }] };
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'get_decision',
    `Get a court decision by case number, ECLI, or file number. Only 'judikaty' source.`,
    {
      source: z.literal('judikaty'),
      identifier: z.string().describe('Case number, ECLI, or file number'),
      sections: z.enum(['all', 'metadata', 'pravni_veta', 'vyrok', 'oduvodneni']).optional().default('all'),
      max_length: z.number().int().min(100).max(100000).optional().default(5000),
    },
    async ({ source, identifier, sections, max_length }) => {
      const sources = await getSources();
      const src = sources.get(source);
      if (!src) return { content: [{ type: 'text' as const, text: `Unknown source: ${source}` }], isError: true };
      try {
        const text = await getDecision(src, identifier, sections, max_length);
        if (!text) return { content: [{ type: 'text' as const, text: `Rozhodnutí "${identifier}" nenalezeno.` }] };
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'get_stats',
    `Get row counts for all tables in a source database, or across all sources.`,
    {
      source: z.string().optional().describe('Specific source, or omit for all'),
    },
    async ({ source }) => {
      const sources = await getSources();
      if (source && !sources.has(source)) {
        return {
          content: [
            { type: 'text' as const, text: `Unknown source: ${source}. Available: ${sourceNames().join(', ')}` },
          ],
          isError: true,
        };
      }
      const targets = source ? [sources.get(source)!] : sourceNames().map((n) => sources.get(n)!);
      const stats = await Promise.all(targets.map((t) => getStats(t)));
      return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
    },
  );

  server.tool(
    'get_schema',
    `Get the SQL schema (CREATE TABLE/INDEX statements) for a source database.`,
    {
      source: z.string().describe('Database source'),
    },
    async ({ source }) => {
      const sources = await getSources();
      const src = sources.get(source);
      if (!src)
        return {
          content: [
            { type: 'text' as const, text: `Unknown source: ${source}. Available: ${sourceNames().join(', ')}` },
          ],
          isError: true,
        };
      const schema = await getSchema(src);
      return { content: [{ type: 'text' as const, text: schema }] };
    },
  );
};
