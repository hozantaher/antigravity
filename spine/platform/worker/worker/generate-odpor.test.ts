const mockCreate = vi.fn();
const mockStream = vi.fn().mockImplementation((params: unknown) => ({
  finalMessage: () => mockCreate(params),
}));
const mockListTools = vi.fn().mockResolvedValue([{ name: 'worker__search' }]);
const mockCallTool = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'tool result text' }],
});

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
    this.messages = { create: mockCreate, stream: mockStream };
  });
  return { default: MockAnthropic };
});

vi.mock('../scripts/lib/mcp-client.js', () => ({
  createMcpClient: vi.fn().mockReturnValue({
    listTools: mockListTools,
    callTool: mockCallTool,
  }),
}));

vi.mock('./web-search.js', () => ({
  searchWeb: vi.fn().mockResolvedValue('1. Web result\n   https://example.com\n   Content'),
}));

import type { UploadedFile } from './firebase.js';

const makeEndTurnResponse = (text: string) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
});

const makeToolUseResponse = (tools: Array<{ name: string; input: Record<string, unknown> }>) => ({
  stop_reason: 'tool_use',
  content: [
    ...tools.map((t, i) => ({ type: 'tool_use', id: `tool_${i}`, name: t.name, input: t.input })),
  ],
  usage: { input_tokens: 800, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
});

const LONG_MARKDOWN = 'A'.repeat(300);

const testFiles: UploadedFile[] = [
  { path: 'uploads/test/pokuta.pdf', buffer: Buffer.from('fake pdf'), contentType: 'application/pdf' },
];

const testMeta = { firstName: 'Jan', lastName: 'Novák' };

describe('generate-odpor', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.MCP_REMOTE_URL = 'https://mcp.test';
    process.env.MCP_REMOTE_SECRET = 'secret';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns markdown and conversationLog', async () => {
    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN)) // main
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed')); // review

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const result = await generateOdpor(testFiles, testMeta);

    expect(result.markdown).toBeTruthy();
    expect(result.conversationLog).toContain('# Conversation Log');
  });

  it('calls MCP tools when Claude returns tool_use', async () => {
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ name: 'search', input: { source: 'judikaty', table: 'decisions', query: 'test', columns: ['pravni_veta'] } }]))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    await generateOdpor(testFiles, testMeta);

    expect(mockCallTool).toHaveBeenCalledWith('worker__search', expect.any(Object));
  });

  it('routes web_search to searchWeb, not MCP', async () => {
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ name: 'web_search', input: { query: 'czech law' } }]))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'));

    vi.resetModules();
    const webSearch = await import('./web-search.js');
    const { generateOdpor } = await import('./generate-odpor.js');
    await generateOdpor(testFiles, testMeta);

    expect(webSearch.searchWeb).toHaveBeenCalledWith('czech law');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('stops after MAX_TOOL_ITERATIONS', async () => {
    // Always return tool_use
    mockCreate.mockResolvedValue(makeToolUseResponse([{ name: 'search', input: { source: 'judikaty', table: 'decisions', query: 'x', columns: ['pravni_veta'] } }]));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');

    // Last response will be tool_use with short text, which triggers the length check
    await expect(generateOdpor(testFiles, testMeta)).rejects.toThrow('too short');

    // Should have been called MAX_TOOL_ITERATIONS + 1 times (initial + iterations)
    expect(mockCreate.mock.calls.length).toBeLessThanOrEqual(17); // 16 calls max + 1 review attempt
  });

  it('throws on document shorter than 200 chars', async () => {
    mockCreate.mockResolvedValueOnce(makeEndTurnResponse('short'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    await expect(generateOdpor(testFiles, testMeta)).rejects.toThrow('too short');
  });

  it('includes userNotes in user message when provided', async () => {
    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const result = await generateOdpor(testFiles, { ...testMeta, userNotes: 'Vozidlo řídil někdo jiný' });

    // Check conversation log for user notes
    expect(result.conversationLog).toContain('Vozidlo řídil někdo jiný');

    // Check API call — first user message should contain userNotes
    const firstCall = mockCreate.mock.calls[0][0];
    const textBlock = firstCall.messages[0].content.find((b: { type: string }) => b.type === 'text');
    expect(textBlock.text).toContain('<user_notes>');
    expect(textBlock.text).toContain('Vozidlo řídil někdo jiný');
  });

  it('omits userNotes when not provided', async () => {
    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    await generateOdpor(testFiles, testMeta);

    const firstCall = mockCreate.mock.calls[0][0];
    const textBlock = firstCall.messages[0].content.find((b: { type: string }) => b.type === 'text');
    expect(textBlock.text).not.toContain('<user_notes>');
  });

  it('conversation log contains token usage summary', async () => {
    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const result = await generateOdpor(testFiles, testMeta);

    expect(result.conversationLog).toContain('## Token Usage');
    expect(result.conversationLog).toContain('Input:');
    expect(result.conversationLog).toContain('Output:');
    expect(result.conversationLog).toContain('Estimated cost: $');
    expect(result.conversationLog).toContain('### Total:');
  });

  it('conversation log contains system prompt', async () => {
    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const result = await generateOdpor(testFiles, testMeta);

    expect(result.conversationLog).toContain('## System Prompt');
    expect(result.conversationLog).toContain('<task>');
  });

  it('review phase applies when output is long enough', async () => {
    const original = LONG_MARKDOWN;
    const reviewed = LONG_MARKDOWN + ' REVIEWED AND IMPROVED';

    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(original))
      .mockResolvedValueOnce(makeEndTurnResponse(reviewed));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const result = await generateOdpor(testFiles, testMeta);

    expect(result.markdown).toBe(reviewed);
    expect(result.conversationLog).toContain('Review');
    expect(result.conversationLog).toContain('applied');
  });

  it('review phase skips when output is too short', async () => {
    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockResolvedValueOnce(makeEndTurnResponse('too short review'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const result = await generateOdpor(testFiles, testMeta);

    expect(result.markdown).toBe(LONG_MARKDOWN);
    expect(result.conversationLog).toContain('skipped');
  });

  it('review phase accepts shortened output above 30% of original', async () => {
    const longOriginal = 'A'.repeat(1000);
    const shortened = 'B'.repeat(350); // 35% of original — would fail old 50% threshold, passes new 30%

    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(longOriginal))
      .mockResolvedValueOnce(makeEndTurnResponse(shortened));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const result = await generateOdpor(testFiles, testMeta);

    expect(result.markdown).toBe(shortened);
    expect(result.conversationLog).toContain('applied');
  });

  it('review phase rejects catastrophically truncated output', async () => {
    const longOriginal = 'A'.repeat(2000);
    const truncated = 'B'.repeat(250); // >= 200 but only 12.5% of original — below 30% ratio

    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(longOriginal))
      .mockResolvedValueOnce(makeEndTurnResponse(truncated));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const result = await generateOdpor(testFiles, testMeta);

    expect(result.markdown).toBe(longOriginal);
    expect(result.conversationLog).toContain('skipped');
  });

  it('review phase handles failure gracefully', async () => {
    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockRejectedValueOnce(new Error('Opus unavailable'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const result = await generateOdpor(testFiles, testMeta);

    expect(result.markdown).toBe(LONG_MARKDOWN);
    expect(result.conversationLog).toContain('failed');
  });

  it('does not reset MCP singleton on tool-level errors', async () => {
    // Tool-level error (JSON-RPC error from callTool) should NOT reset MCP client
    mockCallTool.mockRejectedValueOnce(new Error('[worker] tools/call search: invalid SQL'));

    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ name: 'search', input: { source: 'judikaty', table: 'decisions', query: 'test', columns: ['pravni_veta'] } }]))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN)) // continues after error returned to model
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const result = await generateOdpor(testFiles, testMeta);

    // The tool error is returned to the model as is_error, and the model continues
    expect(result.markdown).toBeTruthy();
    // MCP client should still work — callTool is called again if model retries
    expect(mockCallTool).toHaveBeenCalled();
  });

  it('uses extended thinking in API calls', async () => {
    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    await generateOdpor(testFiles, testMeta);

    const mainCall = mockCreate.mock.calls[0][0];
    expect(mainCall.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
  });

  it('uses prompt caching on system prompt and user message', async () => {
    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    await generateOdpor(testFiles, testMeta);

    const mainCall = mockCreate.mock.calls[0][0];
    // System prompt has cache_control
    expect(mainCall.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // User message last block has cache_control
    const userContent = mainCall.messages[0].content;
    const lastBlock = userContent[userContent.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('calls onProgress callback', async () => {
    mockCreate
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN))
      .mockResolvedValueOnce(makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'));

    vi.resetModules();
    const { generateOdpor } = await import('./generate-odpor.js');
    const onProgress = vi.fn();
    await generateOdpor(testFiles, testMeta, onProgress);

    expect(onProgress).toHaveBeenCalledWith('MCP connected');
    expect(onProgress).toHaveBeenCalledWith('Starting legal analysis...');
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Analysis complete'));
  });
});

// -------------------------------------------------------------------------
// H2 — Singleton race: concurrent first-callers must see exactly 1 client.
// -------------------------------------------------------------------------

describe('generate-odpor - H2 singleton race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_REMOTE_URL = 'https://mcp.test';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  });

  it('50 concurrent first-callers share a single MCP client instance', async () => {
    vi.resetModules();

    // Replace the mcp-client mock with a per-module-load instance counter.
    const createdClients: unknown[] = [];
    vi.doMock('../scripts/lib/mcp-client.js', () => ({
      createMcpClient: vi.fn(() => {
        const client = {
          listTools: vi.fn().mockResolvedValue([{ name: 'worker__search' }]),
          callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
        };
        createdClients.push(client);
        return client;
      }),
    }));
    vi.doMock('@anthropic-ai/sdk', () => {
      const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.messages = {
          stream: vi.fn().mockReturnValue({
            finalMessage: () => Promise.resolve(makeEndTurnResponse(LONG_MARKDOWN)),
          }),
        };
      });
      return { default: MockAnthropic };
    });
    vi.doMock('./web-search.js', () => ({
      searchWeb: vi.fn().mockResolvedValue(''),
    }));

    const { generateOdpor, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();

    // Fire 50 concurrent jobs. Every one triggers ensureMcp() — only ONE
    // createMcpClient() call must actually happen.
    await Promise.all(
      Array.from({ length: 50 }, () => generateOdpor(testFiles, testMeta).catch(() => null)),
    );

    expect(createdClients.length).toBe(1);

    vi.doUnmock('../scripts/lib/mcp-client.js');
    vi.doUnmock('@anthropic-ai/sdk');
    vi.doUnmock('./web-search.js');
  });

  it('init failure clears the handle so a later call retries (no permanent wedge)', async () => {
    vi.resetModules();

    let listCalls = 0;
    vi.doMock('../scripts/lib/mcp-client.js', () => ({
      createMcpClient: vi.fn(() => ({
        listTools: vi.fn(async () => {
          listCalls++;
          if (listCalls === 1) throw new Error('boot transient');
          return [{ name: 'worker__search' }];
        }),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      })),
    }));
    vi.doMock('@anthropic-ai/sdk', () => {
      const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.messages = {
          stream: vi.fn().mockReturnValue({
            finalMessage: () => Promise.resolve(makeEndTurnResponse(LONG_MARKDOWN)),
          }),
        };
      });
      return { default: MockAnthropic };
    });
    vi.doMock('./web-search.js', () => ({
      searchWeb: vi.fn().mockResolvedValue(''),
    }));

    const { generateOdpor, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();

    // First call fails during init.
    await expect(generateOdpor(testFiles, testMeta)).rejects.toThrow('boot transient');
    // Second call must re-attempt init and succeed.
    const result = await generateOdpor(testFiles, testMeta);
    expect(result.markdown).toBeTruthy();
    expect(listCalls).toBe(2);

    vi.doUnmock('../scripts/lib/mcp-client.js');
    vi.doUnmock('@anthropic-ai/sdk');
    vi.doUnmock('./web-search.js');
  });

  it('throws when MCP_REMOTE_URL is missing', async () => {
    vi.resetModules();
    delete process.env.MCP_REMOTE_URL;
    const { generateOdpor, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();
    await expect(generateOdpor(testFiles, testMeta)).rejects.toThrow('MCP_REMOTE_URL');
  });

  it('closeMcp clears the singleton so next call reinits', async () => {
    vi.resetModules();

    let createCalls = 0;
    vi.doMock('../scripts/lib/mcp-client.js', () => ({
      createMcpClient: vi.fn(() => {
        createCalls++;
        return {
          listTools: vi.fn().mockResolvedValue([]),
          callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
        };
      }),
    }));
    vi.doMock('@anthropic-ai/sdk', () => {
      const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.messages = {
          stream: vi.fn().mockReturnValue({
            finalMessage: () => Promise.resolve(makeEndTurnResponse(LONG_MARKDOWN)),
          }),
        };
      });
      return { default: MockAnthropic };
    });
    vi.doMock('./web-search.js', () => ({ searchWeb: vi.fn() }));

    process.env.MCP_REMOTE_URL = 'https://mcp.test';
    const { generateOdpor, closeMcp, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();

    await generateOdpor(testFiles, testMeta);
    expect(createCalls).toBe(1);

    closeMcp(); // graceful shutdown calls this

    await generateOdpor(testFiles, testMeta);
    expect(createCalls).toBe(2); // re-initialized after close

    vi.doUnmock('../scripts/lib/mcp-client.js');
    vi.doUnmock('@anthropic-ai/sdk');
    vi.doUnmock('./web-search.js');
  });
});

// -------------------------------------------------------------------------
// H3 — Pure addUsage + deterministic tool-log order
// -------------------------------------------------------------------------

describe('generate-odpor - H3 addUsage immutability', () => {
  it('returns a new TokenUsage object rather than mutating the input', async () => {
    const { addUsage } = await import('./generate-odpor.js');
    const before = { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 5 };
    const frozen = Object.freeze({ ...before }); // if mutated, throws in strict mode

    const response = {
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 2,
      },
    } as unknown as import('@anthropic-ai/sdk').default.Message;

    const after = addUsage(frozen as typeof before, response);

    // Input untouched.
    expect(frozen).toEqual(before);
    // Output is a new object (reference inequality) with summed fields.
    expect(after).not.toBe(frozen);
    expect(after).toEqual({
      inputTokens: 17,
      outputTokens: 23,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 7,
    });
  });

  it('handles undefined cache fields on the response', async () => {
    const { addUsage } = await import('./generate-odpor.js');
    const base = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const response = {
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    } as unknown as import('@anthropic-ai/sdk').default.Message;
    const result = addUsage(base, response);
    expect(result.cacheCreationInputTokens).toBe(0);
    expect(result.cacheReadInputTokens).toBe(0);
    expect(result.inputTokens).toBe(4);
  });
});

// -------------------------------------------------------------------------
// M5 — Anthropic SDK maxRetries:0 (streamMessage owns all retry logic)
// -------------------------------------------------------------------------

describe('generate-odpor - M5 SDK retry configuration', () => {
  beforeEach(() => {
    process.env.MCP_REMOTE_URL = 'https://mcp.test';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  });

  it('initializes Anthropic with maxRetries: 0 to avoid 12× retry worst-case', async () => {
    vi.resetModules();
    const constructorArgs: unknown[] = [];
    vi.doMock('@anthropic-ai/sdk', () => {
      const MockAnthropic = vi.fn(function (this: Record<string, unknown>, opts: unknown) {
        constructorArgs.push(opts);
        this.messages = {
          stream: vi.fn().mockReturnValue({
            finalMessage: () =>
              Promise.resolve(makeEndTurnResponse(LONG_MARKDOWN)),
          }),
        };
      });
      return { default: MockAnthropic };
    });
    vi.doMock('../scripts/lib/mcp-client.js', () => ({
      createMcpClient: vi.fn(() => ({
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      })),
    }));
    vi.doMock('./web-search.js', () => ({ searchWeb: vi.fn().mockResolvedValue('') }));

    const { generateOdpor, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();
    await generateOdpor(testFiles, testMeta);

    // SDK must be constructed with maxRetries: 0 so streamMessage's own backoff is the only retry path
    expect(constructorArgs[0]).toMatchObject({ maxRetries: 0 });

    vi.doUnmock('@anthropic-ai/sdk');
    vi.doUnmock('../scripts/lib/mcp-client.js');
    vi.doUnmock('./web-search.js');
  });

  it('streamMessage still retries on 429 with its own backoff (SDK retries disabled)', async () => {
    vi.resetModules();
    // Track only stream calls, not review calls — test just the retry of the main request
    let streamCallCount = 0;
    vi.doMock('@anthropic-ai/sdk', () => {
      class FakeAPIError extends Error {
        status: number;
        constructor(msg: string, status: number) {
          super(msg);
          this.status = status;
          Object.setPrototypeOf(this, FakeAPIError.prototype);
        }
      }
      const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.messages = {
          stream: vi.fn().mockReturnValue({
            finalMessage: () => {
              streamCallCount++;
              // First call → 429, subsequent calls succeed
              if (streamCallCount === 1) {
                return Promise.reject(new FakeAPIError('rate limited', 429));
              }
              return Promise.resolve(makeEndTurnResponse(LONG_MARKDOWN));
            },
          }),
        };
      });
      MockAnthropic.APIError = FakeAPIError;
      return { default: MockAnthropic };
    });
    vi.doMock('../scripts/lib/mcp-client.js', () => ({
      createMcpClient: vi.fn(() => ({
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      })),
    }));
    vi.doMock('./web-search.js', () => ({ searchWeb: vi.fn().mockResolvedValue('') }));

    vi.useFakeTimers();
    const { generateOdpor, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();

    const promise = generateOdpor(testFiles, testMeta);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.markdown).toBeTruthy();
    // streamCallCount >= 2: at least one retry happened for the main request
    expect(streamCallCount).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
    vi.doUnmock('@anthropic-ai/sdk');
    vi.doUnmock('../scripts/lib/mcp-client.js');
    vi.doUnmock('./web-search.js');
  });

  it('non-retryable errors (4xx) propagate immediately without retrying', async () => {
    vi.resetModules();
    let callCount = 0;
    vi.doMock('@anthropic-ai/sdk', () => {
      class FakeAPIError extends Error {
        status: number;
        constructor(msg: string, status: number) {
          super(msg);
          this.status = status;
          Object.setPrototypeOf(this, FakeAPIError.prototype);
        }
      }
      const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.messages = {
          stream: vi.fn().mockReturnValue({
            finalMessage: () => {
              callCount++;
              // 400 is not retryable — must throw immediately without retry
              return Promise.reject(new FakeAPIError('invalid request', 400));
            },
          }),
        };
      });
      MockAnthropic.APIError = FakeAPIError;
      return { default: MockAnthropic };
    });
    vi.doMock('../scripts/lib/mcp-client.js', () => ({
      createMcpClient: vi.fn(() => ({
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      })),
    }));
    vi.doMock('./web-search.js', () => ({ searchWeb: vi.fn().mockResolvedValue('') }));

    const { generateOdpor, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();

    await expect(generateOdpor(testFiles, testMeta)).rejects.toThrow('invalid request');
    expect(callCount).toBe(1); // no retry for 4xx

    vi.doUnmock('@anthropic-ai/sdk');
    vi.doUnmock('../scripts/lib/mcp-client.js');
    vi.doUnmock('./web-search.js');
  });
});

// -------------------------------------------------------------------------
// M4 — per-job wallclock budget warning via onProgress
// -------------------------------------------------------------------------

describe('generate-odpor - M4 wallclock budget warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_REMOTE_URL = 'https://mcp.test';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  });

  it('emits a budget-warning progress message after 60% of MAX_TOOL_ITERATIONS', async () => {
    vi.resetModules();

    const toolResponse = makeToolUseResponse([
      { name: 'search', input: { source: 'judikaty', table: 'decisions', query: 'x', columns: ['c'] } },
    ]);
    const endResponse = makeEndTurnResponse(LONG_MARKDOWN);

    // 10 tool iterations → exceeds 60% of MAX_TOOL_ITERATIONS (15) at iter 10
    let callIdx = 0;
    const responses = [
      ...Array(10).fill(toolResponse),
      endResponse,
      endResponse, // review
    ];

    vi.doMock('@anthropic-ai/sdk', () => {
      const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.messages = {
          stream: vi.fn().mockReturnValue({
            finalMessage: () => Promise.resolve(responses[callIdx++] ?? endResponse),
          }),
        };
      });
      return { default: MockAnthropic };
    });
    vi.doMock('../scripts/lib/mcp-client.js', () => ({
      createMcpClient: vi.fn(() => ({
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      })),
    }));
    vi.doMock('./web-search.js', () => ({ searchWeb: vi.fn().mockResolvedValue('') }));

    const { generateOdpor, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();

    const progressMessages: string[] = [];
    await generateOdpor(testFiles, testMeta, (msg) => { progressMessages.push(msg); });

    const budgetWarning = progressMessages.find(
      (m) => m.toLowerCase().includes('budget') || m.toLowerCase().includes('%'),
    );
    expect(budgetWarning).toBeDefined();

    vi.doUnmock('@anthropic-ai/sdk');
    vi.doUnmock('../scripts/lib/mcp-client.js');
    vi.doUnmock('./web-search.js');
  });

  it('does NOT emit budget warning when iterations stay below 60%', async () => {
    vi.resetModules();

    // Only 5 tool iterations (33% of 15) — no warning expected
    const toolResponse = makeToolUseResponse([
      { name: 'search', input: { source: 'judikaty', table: 'decisions', query: 'x', columns: ['c'] } },
    ]);
    const endResponse = makeEndTurnResponse(LONG_MARKDOWN);

    let callIdx = 0;
    const responses = [
      ...Array(5).fill(toolResponse),
      endResponse,
      endResponse,
    ];

    vi.doMock('@anthropic-ai/sdk', () => {
      const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.messages = {
          stream: vi.fn().mockReturnValue({
            finalMessage: () => Promise.resolve(responses[callIdx++] ?? endResponse),
          }),
        };
      });
      return { default: MockAnthropic };
    });
    vi.doMock('../scripts/lib/mcp-client.js', () => ({
      createMcpClient: vi.fn(() => ({
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      })),
    }));
    vi.doMock('./web-search.js', () => ({ searchWeb: vi.fn().mockResolvedValue('') }));

    const { generateOdpor, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();

    const progressMessages: string[] = [];
    await generateOdpor(testFiles, testMeta, (msg) => { progressMessages.push(msg); });

    const budgetWarning = progressMessages.find(
      (m) => m.toLowerCase().includes('budget') || m.toLowerCase().includes('%'),
    );
    expect(budgetWarning).toBeUndefined();

    vi.doUnmock('@anthropic-ai/sdk');
    vi.doUnmock('../scripts/lib/mcp-client.js');
    vi.doUnmock('./web-search.js');
  });

  it('budget warning message includes iteration count and max', async () => {
    vi.resetModules();

    const toolResponse = makeToolUseResponse([
      { name: 'search', input: { source: 'judikaty', table: 'decisions', query: 'x', columns: ['c'] } },
    ]);
    const endResponse = makeEndTurnResponse(LONG_MARKDOWN);

    let callIdx = 0;
    const responses = [
      ...Array(10).fill(toolResponse),
      endResponse,
      endResponse,
    ];

    vi.doMock('@anthropic-ai/sdk', () => {
      const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.messages = {
          stream: vi.fn().mockReturnValue({
            finalMessage: () => Promise.resolve(responses[callIdx++] ?? endResponse),
          }),
        };
      });
      return { default: MockAnthropic };
    });
    vi.doMock('../scripts/lib/mcp-client.js', () => ({
      createMcpClient: vi.fn(() => ({
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      })),
    }));
    vi.doMock('./web-search.js', () => ({ searchWeb: vi.fn().mockResolvedValue('') }));

    const { generateOdpor, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();

    const progressMessages: string[] = [];
    await generateOdpor(testFiles, testMeta, (msg) => { progressMessages.push(msg); });

    // The warning should include some numeric content (iter count or percentage)
    const budgetWarning = progressMessages.find(
      (m) => m.toLowerCase().includes('budget') || m.toLowerCase().includes('%'),
    );
    expect(budgetWarning).toMatch(/\d/); // contains at least one digit

    vi.doUnmock('@anthropic-ai/sdk');
    vi.doUnmock('../scripts/lib/mcp-client.js');
    vi.doUnmock('./web-search.js');
  });
});

describe('generate-odpor - H3 deterministic tool log order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_REMOTE_URL = 'https://mcp.test';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  });

  it('tool call/result blocks appear in the same order as toolBlocks, regardless of resolution order', async () => {
    // Three concurrent tool calls, resolving in reverse order. Log must still
    // be in toolBlocks order (block_0, block_1, block_2), not resolution order.
    const delays = [80, 40, 10];
    const names = ['search', 'read_paragraphs', 'get_decision'];

    vi.resetModules();
    vi.doMock('../scripts/lib/mcp-client.js', () => ({
      createMcpClient: vi.fn(() => ({
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(async (toolName: string) => {
          const idx = names.findIndex((n) => toolName === `worker__${n}`);
          const delay = delays[idx] ?? 0;
          await new Promise((r) => setTimeout(r, delay));
          return { content: [{ type: 'text', text: `result-for-${names[idx]}` }] };
        }),
      })),
    }));

    const seqResponses = [
      {
        stop_reason: 'tool_use',
        content: names.map((n, i) => ({ type: 'tool_use', id: `t_${i}`, name: n, input: { q: n } })),
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      makeEndTurnResponse(LONG_MARKDOWN),
      makeEndTurnResponse(LONG_MARKDOWN + ' reviewed'),
    ];
    let callIdx = 0;
    vi.doMock('@anthropic-ai/sdk', () => {
      const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.messages = {
          stream: vi.fn().mockReturnValue({
            finalMessage: () => Promise.resolve(seqResponses[callIdx++]),
          }),
        };
      });
      return { default: MockAnthropic };
    });
    vi.doMock('./web-search.js', () => ({ searchWeb: vi.fn() }));

    const { generateOdpor, __resetMcpForTests } = await import('./generate-odpor.js');
    __resetMcpForTests();

    const result = await generateOdpor(testFiles, testMeta);

    // Find the positions of each tool's Call header in the log.
    const log = result.conversationLog;
    const pos = (n: string) => log.indexOf(`## Tool Call: ${n}`);
    expect(pos('search')).toBeGreaterThan(-1);
    expect(pos('read_paragraphs')).toBeGreaterThan(-1);
    expect(pos('get_decision')).toBeGreaterThan(-1);
    // Order must match tool-block order (index order), not resolution order.
    expect(pos('search')).toBeLessThan(pos('read_paragraphs'));
    expect(pos('read_paragraphs')).toBeLessThan(pos('get_decision'));

    // The Tool Result for block N must come BEFORE Tool Call for block N+1.
    const resultPos = (n: string) => log.indexOf(`## Tool Result: ${n}`);
    expect(resultPos('search')).toBeLessThan(pos('read_paragraphs'));
    expect(resultPos('read_paragraphs')).toBeLessThan(pos('get_decision'));

    vi.doUnmock('../scripts/lib/mcp-client.js');
    vi.doUnmock('@anthropic-ai/sdk');
    vi.doUnmock('./web-search.js');
  });
});

