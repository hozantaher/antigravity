import Anthropic from '@anthropic-ai/sdk';
import { createMcpClient, McpRequestError, type McpClient } from '../scripts/lib/mcp-client.js';
import { searchWeb } from './web-search.js';
import type { UploadedFile } from './firebase.js';
import { SYSTEM_PROMPT_TEXT, REVIEW_PROMPT } from './prompts.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const REVIEW_MODEL = process.env.ANTHROPIC_MODEL_REVIEW || 'claude-opus-4-6';
const MAX_TOKENS = 65536;
const MAX_TOOL_ITERATIONS = 15;
// M4: Each iteration budget — warn when > 60% of iterations consumed.
// Does not abort the job, only signals via onProgress so the caller can log.
const TOOL_BUDGET_WARN_FRACTION = 0.6;
const MAX_REVIEW_TOKENS = 16384;
const THINKING_BUDGET = 10000;

export interface GenerateResult {
  markdown: string;
  conversationLog: string;
}

// --- Token tracking ---

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

// H3 fix: pure addition — returns a new TokenUsage rather than mutating.
// Prevents hidden side effects when usage totals are shared or threaded
// through concurrent flows.
export const addUsage = (total: TokenUsage, response: Anthropic.Message): TokenUsage => ({
  inputTokens: total.inputTokens + response.usage.input_tokens,
  outputTokens: total.outputTokens + response.usage.output_tokens,
  cacheCreationInputTokens:
    total.cacheCreationInputTokens + (response.usage.cache_creation_input_tokens ?? 0),
  cacheReadInputTokens:
    total.cacheReadInputTokens + (response.usage.cache_read_input_tokens ?? 0),
});

// Pricing per 1M tokens (USD)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

const DEFAULT_PRICING = PRICING['claude-sonnet-4-6'];

const estimateCost = (model: string, usage: TokenUsage): number => {
  const p = PRICING[model] || DEFAULT_PRICING;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadInputTokens * p.cacheRead +
      usage.cacheCreationInputTokens * p.cacheWrite) /
    1_000_000
  );
};

// --- Singleton clients (reused across jobs) ---

// M5: Set maxRetries: 0 so the SDK never retries internally. All retry logic
// (jittered backoff, 429/529/5xx handling) lives exclusively in streamMessage.
// Without this, combined worst-case is 4 (SDK) × 4 (streamMessage) = 16 attempts
// per request, which means 15 iters × 16 = 240 Anthropic requests per job.
const anthropic = new Anthropic({ maxRetries: 0 });

// H2 fix: generation-tagged singleton.
//
// Previously `mcp` and `mcpInitPromise` were two independent nullable fields;
// under CONCURRENCY=2 a tool-call error from job B could null both refs while
// job A's init was still in flight, forcing a second init even though the
// original client was already healthy. Two concurrent first-callers could also
// each see `null` for a micro-window and start racing inits.
//
// The fix wraps init in a single memoized promise keyed by a generation number.
// Resets compare-and-swap against the generation they observed, so a stale
// reset (e.g. from an already-superseded client) is a no-op.
interface McpHandle {
  readonly generation: number;
  readonly client: Promise<McpClient>;
}

let mcpHandle: McpHandle | null = null;
let mcpGeneration = 0;

export const __resetMcpForTests = (): void => {
  mcpHandle = null;
  mcpGeneration = 0;
};

const initMcp = (generation: number): Promise<McpClient> => {
  return Promise.resolve().then(async () => {
    const mcpUrl = process.env.MCP_REMOTE_URL;
    if (!mcpUrl) throw new Error('MCP_REMOTE_URL is required');
    const client = createMcpClient({
      baseUrl: mcpUrl,
      secret: process.env.MCP_REMOTE_SECRET,
      prefix: 'worker',
    });
    try {
      await client.listTools();
    } catch (e) {
      // Init failed — clear handle so a subsequent call retries. Only clear
      // if this is still the active handle (compare generation).
      if (mcpHandle && mcpHandle.generation === generation) {
        mcpHandle = null;
      }
      throw e;
    }
    return client;
  });
};

const ensureMcp = async (): Promise<{ client: McpClient; generation: number }> => {
  if (!mcpHandle) {
    const generation = ++mcpGeneration;
    mcpHandle = { generation, client: initMcp(generation) };
  }
  const handle = mcpHandle;
  const client = await handle.client;
  return { client, generation: handle.generation };
};

/** Invalidate the MCP singleton IFF the caller's generation matches the active handle.
 *  Stale resets (from an already-replaced client) are no-ops. */
const invalidateMcp = (generation: number): void => {
  if (mcpHandle && mcpHandle.generation === generation) {
    mcpHandle = null;
  }
};

/** Exported for the shutdown path to release the MCP client during graceful shutdown. */
export const closeMcp = (): void => {
  mcpHandle = null;
};

// System prompt as array with cache_control — enables prompt caching
// so repeated API calls in the agentic loop pay only cache read fee (~1/10 cost).
const SYSTEM_PROMPT: Anthropic.TextBlockParam[] = [
  { type: 'text', text: SYSTEM_PROMPT_TEXT, cache_control: { type: 'ephemeral' } },
];

// --- Claude API tool definitions (matching MCP server schemas) ---

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search',
    description:
      'Full-text search across Czech court decisions and legislation. Uses Typesense (fast, typo-tolerant) for judikaty and esbirka.',
    input_schema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Database source: judikaty, esbirka' },
        table: { type: 'string', description: "Table to search: 'decisions', 'acts'" },
        query: { type: 'string', description: 'Search query' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Columns to search' },
        filter: { type: 'string', description: "Optional SQL filter, e.g. \"source = 'nsoud'\"" },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
      required: ['source', 'table', 'query', 'columns'],
    },
  },
  {
    name: 'read_paragraphs',
    description: "Extract specific paragraphs (§§) from a Czech law's full text.",
    input_schema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', enum: ['esbirka'] },
        citace: { type: 'string', description: "Law citation, e.g. '89/2012 Sb.'" },
        paragraphs: { type: 'array', items: { type: 'string' }, description: "Paragraph numbers, e.g. ['150', '151']" },
      },
      required: ['source', 'citace', 'paragraphs'],
    },
  },
  {
    name: 'get_decision',
    description: 'Get a court decision by case number, ECLI, or file number.',
    input_schema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', enum: ['judikaty'] },
        identifier: { type: 'string', description: 'Case number, ECLI, or file number' },
        sections: {
          type: 'string',
          enum: ['all', 'metadata', 'pravni_veta', 'vyrok', 'oduvodneni'],
          description: 'Which sections to return (default: all)',
        },
        max_length: { type: 'number', description: 'Max text length per section (default 5000)' },
      },
      required: ['source', 'identifier'],
    },
  },
  {
    name: 'get_law_context',
    description: 'Get metadata about a Czech law: title, validity, amendments, related laws.',
    input_schema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', enum: ['esbirka'] },
        citace: { type: 'string', description: "Law citation, e.g. '500/2004 Sb.'" },
      },
      required: ['source', 'citace'],
    },
  },
  {
    name: 'query',
    description:
      'Execute a read-only SQL query against a scraper database. Use unprefixed table names. Response capped at 100KB.',
    input_schema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Database source (judikaty, esbirka, etc.)' },
        sql: { type: 'string', description: 'SQL SELECT query' },
        limit: { type: 'number', description: 'Max rows (default 100, max 1000)' },
      },
      required: ['source', 'sql'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for current Czech legal information, regulations, device certifications, or municipal ordinances not available in the database.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (Czech or English)' },
      },
      required: ['query'],
    },
    cache_control: { type: 'ephemeral' },
  },
];

// --- Content block helpers ---

const fileToContentBlock = (file: UploadedFile): Anthropic.ContentBlockParam => {
  if (file.contentType === 'application/pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') },
    };
  }
  const validImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!validImageTypes.has(file.contentType)) {
    throw new Error(`Unsupported file type: ${file.contentType}`);
  }
  const mediaType = file.contentType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: file.buffer.toString('base64') },
  };
};

/** Extract text blocks from a Claude response */
const extractText = (content: Anthropic.ContentBlock[]): string =>
  content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

/**
 * Stream a message and return the final Message object (avoids 10-min
 * timeout on long requests).
 *
 * D-1 — wrap the stream in an AbortController so a hung Anthropic
 * connection doesn't pin a worker forever. Default timeout 8 min;
 * env-overridable via LLM_TIMEOUT_MS. Timeout errors are NOT retried
 * (same backend hung once will hang again — better to fail the job
 * and let BullMQ replay than to extend the wedge).
 *
 * Exported for unit testing; consumers should use generateOdpor.
 */
export const streamMessage = async (
  params: Anthropic.MessageCreateParams,
  maxRetries = 3,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 8 * 60 * 1000),
): Promise<Anthropic.Message> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`LLM stream timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const stream = anthropic.messages.stream(params, { signal: ctrl.signal });
      const msg = await stream.finalMessage();
      clearTimeout(timer);
      return msg;
    } catch (e) {
      clearTimeout(timer);
      // AbortError from our timeout: don't retry, surface as-is.
      if (ctrl.signal.aborted) {
        throw ctrl.signal.reason ?? new Error('LLM stream aborted');
      }
      const isRetryable =
        e instanceof Anthropic.APIError && (e.status === 429 || e.status === 529 || e.status >= 500);
      if (!isRetryable || attempt === maxRetries) throw e;
      const delay = 1000 * 2 ** attempt + Math.random() * 500; // 1-1.5s, 2-2.5s, 4-4.5s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
};

// --- Main generation function ---

export const generateOdpor = async (
  files: UploadedFile[],
  meta: { firstName: string; lastName: string; prompt?: string; userNotes?: string },
  onProgress?: (message: string) => void,
): Promise<GenerateResult> => {
  const { client, generation: mcpGen } = await ensureMcp();
  onProgress?.('MCP connected');

  // --- Token tracking ---
  let mainUsage = emptyUsage();
  let reviewUsage = emptyUsage();

  // --- Conversation log ---
  const log: string[] = [];
  const ts = new Date().toISOString();
  const today = ts.split('T')[0];

  log.push(`# Conversation Log — ${ts}`);
  log.push(`Model: ${MODEL} (thinking budget: ${THINKING_BUDGET})`);
  log.push(`Review model: ${REVIEW_MODEL}`);
  log.push('');
  log.push('## System Prompt');
  log.push('');
  log.push(SYSTEM_PROMPT_TEXT);
  log.push('');
  log.push('## User Message');
  log.push('');
  log.push(`Files: ${files.map((f) => `${f.path} (${f.contentType})`).join(', ')}`);
  log.push(`Dnešní datum: ${today}`);
  log.push(`Účastník řízení: ${meta.firstName} ${meta.lastName}`);
  if (meta.userNotes) {
    log.push(`Poznámka uživatele: ${meta.userNotes}`);
  }
  log.push(meta.prompt || 'Rozporuj tuto pokutu. Vytvoř kompletní odpor/rozklad.');
  log.push('');

  const callMcpTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    try {
      const result = await client.callTool(`worker__${name}`, args);
      return result.content
        .filter((c): c is { type: string; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    } catch (e) {
      // Only invalidate the shared MCP client on transport-level failures
      // (TypeError from fetch, non-2xx status via McpRequestError). Tool-level
      // JSON-RPC errors (bad SQL, unknown citace) are surfaced to the model as
      // is_error and MUST NOT reset the singleton — otherwise one bad tool call
      // tears down MCP for every other in-flight job.
      if (e instanceof TypeError || e instanceof McpRequestError) {
        invalidateMcp(mcpGen);
      }
      throw e;
    }
  };

  const userPrompt = meta.prompt || 'Rozporuj tuto pokutu. Vytvoř kompletní odpor/rozklad.';

  // Build user message — include userNotes if provided
  let userText = `Dnešní datum: ${today}\nÚčastník řízení: ${meta.firstName} ${meta.lastName}\n\n${userPrompt}`;
  if (meta.userNotes) {
    userText += `\n\n<user_notes>\nDodatečné informace od uživatele:\n${meta.userNotes}\n</user_notes>`;
  }

  const contentBlocks: Anthropic.ContentBlockParam[] = [
    ...files.map(fileToContentBlock),
    { type: 'text', text: userText, cache_control: { type: 'ephemeral' } },
  ];

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: contentBlocks }];

  onProgress?.('Starting legal analysis...');

  let response = await streamMessage({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET },
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });
  mainUsage = addUsage(mainUsage, response);

  let iterations = 0;

  while (response.stop_reason === 'tool_use' && iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    // Log assistant text (if any before tool calls)
    const assistantText = extractText(response.content);
    if (assistantText) {
      log.push(`## Assistant (iteration ${iterations})`);
      log.push('');
      log.push(assistantText);
      log.push('');
    }

    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    const pct = Math.round((iterations / MAX_TOOL_ITERATIONS) * 100);
    const budgetMsg = `Tool call ${iterations}/${MAX_TOOL_ITERATIONS}: ${toolBlocks.map((b) => b.name).join(', ')}`;
    onProgress?.(budgetMsg);
    // M4: emit a budget warning when iteration count exceeds the threshold so
    // Railway logs surface jobs that are approaching the slot ceiling.
    if (iterations / MAX_TOOL_ITERATIONS > TOOL_BUDGET_WARN_FRACTION) {
      onProgress?.(`Tool budget warning: ${iterations}/${MAX_TOOL_ITERATIONS} iterations (${pct}%) — approaching limit`);
    }

    // H3 fix: collect per-block log fragments and splice in tool-block order
    // after Promise.all resolves. Previously log.push was interleaved by
    // resolution time, giving a non-deterministic log that made agent replay
    // debugging impossible.
    type ToolOutcome = {
      logFragment: string[];
      result: Anthropic.ToolResultBlockParam;
    };

    const outcomes: ToolOutcome[] = await Promise.all(
      toolBlocks.map(async (block): Promise<ToolOutcome> => {
        const fragment: string[] = [
          `## Tool Call: ${block.name}`,
          '',
          '```json',
          JSON.stringify(block.input, null, 2),
          '```',
          '',
        ];

        try {
          const args = block.input as Record<string, unknown>;
          const text = block.name === 'web_search'
            ? await searchWeb(args.query as string)
            : await callMcpTool(block.name, args);
          const truncated = text.length > 10_000 ? text.slice(0, 10_000) + '\n... (zkráceno)' : text;

          fragment.push(
            `## Tool Result: ${block.name} (${text.length} chars)`,
            '',
            text.length > 3_000 ? text.slice(0, 3_000) + '\n... (zkráceno v logu)' : text,
            '',
          );

          return {
            logFragment: fragment,
            result: { type: 'tool_result' as const, tool_use_id: block.id, content: truncated },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          fragment.push(`## Tool Result: ${block.name} — ERROR`, '', msg, '');
          return {
            logFragment: fragment,
            result: {
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: `Error: ${msg}`,
              is_error: true,
            },
          };
        }
      }),
    );

    for (const outcome of outcomes) {
      log.push(...outcome.logFragment);
    }
    const toolResults: Anthropic.ToolResultBlockParam[] = outcomes.map((o) => o.result);

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await streamMessage({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    mainUsage = addUsage(mainUsage, response);
  }

  onProgress?.(`Analysis complete after ${iterations} tool calls`);

  let markdown = extractText(response.content);

  log.push(`## Final Output (${markdown.length} chars)`);
  log.push('');
  log.push(markdown);
  log.push('');

  if (!markdown || markdown.length < 200) {
    throw new Error(`Generated document too short (${markdown.length} chars). Model may have failed.`);
  }

  // --- Self-reflection review ---
  onProgress?.('Starting self-reflection review...');

  try {
    const reviewResponse = await streamMessage({
      model: REVIEW_MODEL,
      max_tokens: MAX_REVIEW_TOKENS,
      temperature: 0.1,
      system: REVIEW_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: markdown }],
        },
      ],
    });
    reviewUsage = addUsage(reviewUsage, reviewResponse);

    const reviewed = extractText(reviewResponse.content);

    if (reviewed && reviewed.length >= 200 && reviewed.length > markdown.length * 0.3) {
      log.push(`## Review (${REVIEW_MODEL}) — applied (${reviewed.length} chars)`);
      log.push('');
      log.push(reviewed);
      log.push('');
      markdown = reviewed;
      onProgress?.('Self-reflection applied');
    } else {
      log.push(`## Review (${REVIEW_MODEL}) — skipped (output too short: ${reviewed.length} chars)`);
      log.push('');
      onProgress?.('Self-reflection skipped (low-quality output)');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.push(`## Review (${REVIEW_MODEL}) — failed: ${msg}`);
    log.push('');
    onProgress?.('Self-reflection failed, using original output');
  }

  // --- Token usage summary ---
  const mainCost = estimateCost(MODEL, mainUsage);
  const reviewCost = estimateCost(REVIEW_MODEL, reviewUsage);

  log.push('## Token Usage');
  log.push('');
  log.push(`### Main (${MODEL})`);
  log.push(`- Input: ${mainUsage.inputTokens.toLocaleString()} tokens`);
  log.push(`- Output: ${mainUsage.outputTokens.toLocaleString()} tokens`);
  log.push(`- Cache read: ${mainUsage.cacheReadInputTokens.toLocaleString()} tokens`);
  log.push(`- Cache write: ${mainUsage.cacheCreationInputTokens.toLocaleString()} tokens`);
  log.push(`- Estimated cost: $${mainCost.toFixed(4)}`);
  log.push('');
  log.push(`### Review (${REVIEW_MODEL})`);
  log.push(`- Input: ${reviewUsage.inputTokens.toLocaleString()} tokens`);
  log.push(`- Output: ${reviewUsage.outputTokens.toLocaleString()} tokens`);
  log.push(`- Estimated cost: $${reviewCost.toFixed(4)}`);
  log.push('');
  log.push(`### Total: $${(mainCost + reviewCost).toFixed(4)}`);
  log.push('');

  return { markdown, conversationLog: log.join('\n') };
};
