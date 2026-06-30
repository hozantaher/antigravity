import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../vitest.setup';
import { z } from 'zod';
import {
  RunpodProvider,
  MockProvider,
  GeminiProvider,
  completeStructured,
  providerFromEnv,
  stripFences,
  extractJson,
} from './provider';

const RUNPOD_URL = 'https://fake-pod.runpod.net/v1';
const CHAT = `${RUNPOD_URL}/chat/completions`;

const openaiReply = (content: string) =>
  HttpResponse.json({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'qwen2.5:14b-instruct',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const runpod = () =>
  new RunpodProvider({ apiKey: 'test-key', baseURL: RUNPOD_URL, model: 'qwen2.5:14b-instruct' });

describe('pure helpers', () => {
  it('stripFences sundá ```json obal', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });
  it('extractJson zvládne i prózu kolem JSON', () => {
    expect(extractJson('Tady je výsledek: {"a":1} hotovo')).toEqual({ a: 1 });
    expect(extractJson('naprostý nesmysl')).toBeUndefined();
  });
});

describe('RunpodProvider (OpenAI-kompatibilní, MSW)', () => {
  it('available dle klíče+URL', () => {
    expect(runpod().available).toBe(true);
    expect(new RunpodProvider({ apiKey: '', baseURL: '', model: 'm' }).available).toBe(false);
  });

  it('complete vrátí obsah z podu', async () => {
    server.use(http.post(CHAT, () => openaiReply('Ahoj z RunPodu')));
    const out = await runpod().complete([{ role: 'user', content: 'ping' }]);
    expect(out).toBe('Ahoj z RunPodu');
  });
});

describe('completeStructured (Zod brána + retry/drop)', () => {
  const schema = z.object({ foo: z.string(), n: z.number() });

  it('vrátí validovaný objekt při validním JSON', async () => {
    server.use(http.post(CHAT, () => openaiReply('{"foo":"bar","n":5}')));
    const out = await completeStructured(runpod(), [{ role: 'user', content: 'x' }], schema);
    expect(out).toEqual({ foo: 'bar', n: 5 });
  });

  it('DROP → null při trvale nevalidním výstupu (anti-halucinace)', async () => {
    server.use(http.post(CHAT, () => openaiReply('rozhodně to není JSON')));
    const out = await completeStructured(runpod(), [{ role: 'user', content: 'x' }], schema, {
      maxRetries: 1,
    });
    expect(out).toBeNull();
  });

  it('RETRY uspěje: nejdřív garbage, pak validní JSON', async () => {
    let calls = 0;
    server.use(
      http.post(CHAT, () => {
        calls += 1;
        return openaiReply(calls === 1 ? 'eh?' : '{"foo":"ok","n":2}');
      }),
    );
    const out = await completeStructured(runpod(), [{ role: 'user', content: 'x' }], schema, {
      maxRetries: 2,
    });
    expect(out).toEqual({ foo: 'ok', n: 2 });
    expect(calls).toBe(2);
  });

  it('DROP → null když schéma nesedí (Zod zahodí halucinaci)', async () => {
    // validní JSON, ale špatný typ (n je string)
    server.use(http.post(CHAT, () => openaiReply('{"foo":"bar","n":"NaN"}')));
    const out = await completeStructured(runpod(), [{ role: 'user', content: 'x' }], schema, {
      maxRetries: 1,
    });
    expect(out).toBeNull();
  });
});

describe('MockProvider (bez sítě)', () => {
  it('vrátí deterministicky bez síťového volání', async () => {
    const m = new MockProvider(() => '{"ok":true}');
    expect(await m.complete([{ role: 'user', content: 'x' }])).toBe('{"ok":true}');
  });
});

describe('providerFromEnv', () => {
  it('Mock bez klíčů', () => {
    expect(providerFromEnv({}).name).toBe('mock');
  });
  it('RunPod při RUNPOD_API_KEY + RUNPOD_URL', () => {
    const p = providerFromEnv({ RUNPOD_API_KEY: 'k', RUNPOD_URL: RUNPOD_URL });
    expect(p.name).toBe('runpod');
    expect(p.available).toBe(true);
  });
  it('Gemini při GEMINI_API_KEY', () => {
    expect(providerFromEnv({ GEMINI_API_KEY: 'g' }).name).toBe('gemini');
    expect(new GeminiProvider({ apiKey: '' }).available).toBe(false);
  });
});
