/**
 * D-1 — Sprint D worker M1: LLM timeout injection on the streamMessage
 * helper. Locks the AbortController plumbing + timeout-not-retried
 * contract.
 */

import { vi } from 'vitest';

// vi.hoisted lets us reference these inside the vi.mock factory below
// (factories are hoisted above regular const declarations).
const { mockStream } = vi.hoisted(() => ({ mockStream: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
    this.messages = { create: vi.fn(), stream: mockStream };
  });
  // Anthropic.APIError needs to be importable for the retryable check.
  // Provide a minimal class that extends Error and carries `status`.
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'APIError';
    }
  }
  // @ts-expect-error: attaching APIError to constructor like the real SDK.
  MockAnthropic.APIError = APIError;
  return { default: MockAnthropic, APIError };
});

vi.mock('../scripts/lib/mcp-client.js', () => ({
  createMcpClient: vi.fn(),
}));

import { describe, it, expect, beforeEach } from 'vitest';
import { streamMessage } from './generate-odpor.js';

beforeEach(() => {
  mockStream.mockReset();
});

describe('streamMessage — D-1 timeout', () => {
  it('happy path: returns the message when finalMessage resolves before timeout', async () => {
    const expected = { content: [{ type: 'text', text: 'ok' }] };
    mockStream.mockReturnValue({ finalMessage: vi.fn().mockResolvedValue(expected) });
    const result = await streamMessage({ model: 'm', max_tokens: 10, messages: [] } as never, 0, 1000);
    expect(result).toEqual(expected);
  });

  it('passes a signal option to anthropic.messages.stream so the SDK can abort', async () => {
    mockStream.mockReturnValue({ finalMessage: vi.fn().mockResolvedValue({ content: [] }) });
    await streamMessage({ model: 'm', max_tokens: 10, messages: [] } as never, 0, 1000);
    expect(mockStream).toHaveBeenCalled();
    const optionsArg = mockStream.mock.calls[0][1];
    expect(optionsArg).toBeDefined();
    expect(optionsArg.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws timeout error when finalMessage hangs past timeoutMs', async () => {
    // finalMessage never resolves — relies on the AbortController to
    // surface the timeout.
    mockStream.mockReturnValue({
      finalMessage: vi.fn().mockImplementation(
        (): Promise<never> => new Promise(() => { /* hangs forever */ }),
      ),
    });
    // Drive a real AbortController by giving streamMessage a tiny timeout.
    // The `finalMessage` mock doesn't watch the signal, so we have to
    // simulate the abort triggering an error. The wrapper catches the
    // signal.aborted state regardless.
    // To make the test deterministic, replace finalMessage with one that
    // listens to the signal.
    const args = (mockStream.mock.calls[0]?.[1] ?? {}) as { signal?: AbortSignal };
    void args; // unused; documenting intent.

    mockStream.mockReturnValue({
      finalMessage: function (this: unknown) {
        // Read the most-recent signal passed to mockStream.
        return new Promise((_resolve, reject) => {
          const signal: AbortSignal | undefined = mockStream.mock.calls.at(-1)?.[1]?.signal;
          if (signal) {
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
          }
        });
      },
    });

    await expect(streamMessage(
      { model: 'm', max_tokens: 10, messages: [] } as never,
      0,
      30, // 30 ms — keeps the test fast
    )).rejects.toThrow(/timeout|aborted/i);
  });

  it('does NOT retry on timeout (the backend that hung will hang again)', async () => {
    let calls = 0;
    mockStream.mockImplementation(() => {
      calls++;
      return {
        finalMessage: () => new Promise((_resolve, reject) => {
          const signal: AbortSignal | undefined = mockStream.mock.calls.at(-1)?.[1]?.signal;
          if (signal) signal.addEventListener('abort', () => reject(signal.reason));
        }),
      };
    });

    await expect(streamMessage(
      { model: 'm', max_tokens: 10, messages: [] } as never,
      3, // up to 3 retries allowed by the helper
      20,
    )).rejects.toThrow();

    // Timeout aborted on first attempt → no retries.
    expect(calls).toBe(1);
  });

  it('still retries on retryable APIError (5xx, 429) — timeout path didn\'t change retry semantics', async () => {
    const Anthropic = await import('@anthropic-ai/sdk');
    let calls = 0;
    mockStream.mockImplementation(() => {
      calls++;
      if (calls < 3) {
        return {
          // @ts-expect-error: APIError attached on the mock constructor.
          finalMessage: () => Promise.reject(new Anthropic.default.APIError(503, 'try again')),
        };
      }
      return { finalMessage: () => Promise.resolve({ content: [] } as never) };
    });

    const result = await streamMessage({ model: 'm', max_tokens: 10, messages: [] } as never, 3, 1000);
    expect(result).toBeDefined();
    expect(calls).toBe(3); // 2 failed + 1 succeeded
  });
});
