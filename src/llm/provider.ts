import OpenAI from 'openai';
import * as fs from 'fs';
import { z } from 'zod';

/**
 * Jednotná LLM provider abstrakce pro Antigravity engine.
 *
 * Stav před tímto modulem (viz sonda C): žádný provider interface neexistoval — LLM volání byla
 * inline a ad-hoc (jules.ts Gemini fetch, parser-compiler/compiler.ts OpenAI-kompat). RunPod už byl
 * *zapojený* přes OpenAI SDK (`new OpenAI({ apiKey: RUNPOD_API_KEY, baseURL: RUNPOD_URL })`), jen
 * neformalizovaný. Tady ho formalizujeme + přidáme structured-output bránu (Zod safeParse + retry +
 * drop), která je analogem self-healing.ts:43 ("Zod zahodil halucinaci LLM").
 *
 * Klíče se čtou VÝHRADNĚ z env (process.env.RUNPOD_API_KEY…), nikdy nejsou v kódu.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  json?: boolean; // požádat backend o JSON režim (+ stejně strippujeme fences)
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmProvider {
  readonly name: string;
  /** Má provider vše potřebné (klíč/endpoint), aby reálně volal? Jinak je to no-op/mock. */
  readonly available: boolean;
  complete(messages: LlmMessage[], opts?: CompleteOptions): Promise<string>;
}

// ── Pomocné: čištění výstupu + lenient JSON extrakce ─────────────────────────
/** Odstraní ```json … ``` obal (parser-compiler/compiler.ts:43 vzor). */
export const stripFences = (s: string): string =>
  s
    .replace(/^\s*```(?:json|ts|typescript)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

/** Pokus o JSON i z výstupu obaleného prózou — vrátí undefined při selhání. */
export const extractJson = (raw: string): unknown => {
  const cleaned = stripFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    /* zkus vyseknout první {...} nebo [...] blok */
  }
  const first = cleaned.search(/[{[]/);
  const last = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
};

// ── RunPod (OpenAI-kompatibilní GPU pod / Ollama) ────────────────────────────
export interface RunpodConfig {
  apiKey: string;
  baseURL: string; // např. https://<pod>.proxy.runpod.net/v1
  model: string; // default qwen2.5:14b-instruct
  timeoutMs?: number;
}

export class RunpodProvider implements LlmProvider {
  readonly name = 'runpod';
  private _client?: OpenAI;
  constructor(private cfg: RunpodConfig) {}
  get available(): boolean {
    return Boolean(this.cfg.apiKey && this.cfg.baseURL);
  }
  // Lazy: OpenAI SDK hází při prázdném apiKey už v konstruktoru → klienta stavíme až při volání,
  // aby šlo bezpečně zkonstruovat i nedostupného providera (available=false) bez výjimky.
  private client(): OpenAI {
    if (!this._client) {
      this._client = new OpenAI({
        apiKey: this.cfg.apiKey || 'sk-noauth', // RunPod/Ollama nemusí vyžadovat auth
        baseURL: this.cfg.baseURL,
        timeout: this.cfg.timeoutMs ?? 60_000,
        maxRetries: 0, // retry řešíme my (s korekčním promptem), ne slepě
      });
    }
    return this._client;
  }
  async complete(messages: LlmMessage[], opts?: CompleteOptions): Promise<string> {
    const res = await this.client().chat.completions.create({
      model: this.cfg.model,
      messages,
      temperature: opts?.temperature ?? 0.2,
      ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
    });
    return stripFences(res.choices[0]?.message?.content ?? '');
  }
}

// ── Gemini (existující fallback, vytaženo z jules.ts:93 do providera) ────────
export interface GeminiConfig {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private model: string;
  constructor(private cfg: GeminiConfig) {
    this.model = cfg.model ?? 'gemini-2.5-pro';
  }
  get available(): boolean {
    return Boolean(this.cfg.apiKey);
  }
  async complete(messages: LlmMessage[], opts?: CompleteOptions): Promise<string> {
    const prompt = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.cfg.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: opts?.json ? 'application/json' : 'text/plain',
          temperature: opts?.temperature ?? 0.2,
        },
      }),
      signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data: any = await res.json();
    return stripFences(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
  }
}

// ── Mock (deterministický fallback — bez sítě; pro testy a běh bez klíče) ─────
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly available = true;
  constructor(private responder: (messages: LlmMessage[]) => string) {}
  async complete(messages: LlmMessage[]): Promise<string> {
    return this.responder(messages);
  }
}

// ── Structured output brána (provider-agnostická): force JSON → Zod → retry/drop
/**
 * Zavolá providera, vynutí JSON, validuje Zod schématem. Při nevalidním výstupu přidá korekční
 * zprávu a zkusí znovu. Po vyčerpání pokusů vrátí null (uzel zůstane pending — NIKDY se nezapíše
 * halucinace). Analog self-healing.ts:43 + jules anti-tautology filozofie.
 */
export async function completeStructured<T>(
  provider: LlmProvider,
  messages: LlmMessage[],
  schema: z.ZodType<T>,
  opts?: { maxRetries?: number; timeoutMs?: number },
): Promise<T | null> {
  const maxRetries = opts?.maxRetries ?? 2;
  let convo = [...messages];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let raw: string;
    try {
      raw = await provider.complete(convo, {
        json: true,
        temperature: attempt === 0 ? 0.2 : 0.5,
        timeoutMs: opts?.timeoutMs,
      });
    } catch {
      if (attempt === maxRetries) return null;
      continue;
    }
    const parsed = extractJson(raw);
    if (parsed !== undefined) {
      const r = schema.safeParse(parsed);
      if (r.success) return r.data;
      convo = [
        ...convo,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content:
            'Výstup neprošel validací schématu. Vrať POUZE validní JSON přesně dle schématu, bez ' +
            'komentářů a bez markdown fences.',
        },
      ];
    } else {
      convo = [
        ...convo,
        { role: 'assistant', content: raw },
        { role: 'user', content: 'To nebyl JSON. Vrať POUZE validní JSON objekt.' },
      ];
    }
  }
  return null;
}

// ── Factory z env ────────────────────────────────────────────────────────────
const readPodUrlFile = (): string | undefined => {
  try {
    const p = '/tmp/runpod_llm_url';
    if (fs.existsSync(p)) {
      const url = fs.readFileSync(p, 'utf-8').trim();
      return url ? `${url.replace(/\/$/, '')}/v1` : undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
};

const readPodModelFile = (): string | undefined => {
  try {
    const p = '/tmp/runpod_llm_model';
    if (fs.existsSync(p)) {
      const m = fs.readFileSync(p, 'utf-8').trim();
      return m || undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
};

const deterministicFallback = (messages: LlmMessage[]): string => {
  // Bez klíče: žádný výmysl. Vrátíme prázdný JSON objekt → structured brána ho zahodí a uzel
  // zůstane pending. (Engine kvůli chybějícímu LLM nikdy nespadne.)
  void messages;
  return '{}';
};

export interface ProviderEnv {
  RUNPOD_API_KEY?: string;
  RUNPOD_URL?: string;
  OLLAMA_URL?: string;
  OPENAI_API_KEY?: string;
  LLM_MODEL?: string;
  GEMINI_API_KEY?: string;
}

/** Vybere providera dle env: RunPod → Gemini → Mock. Nikdy nehází kvůli chybějícímu klíči. */
export function providerFromEnv(env: ProviderEnv = process.env): LlmProvider {
  const apiKey = env.RUNPOD_API_KEY || env.OPENAI_API_KEY;
  const baseURL = env.RUNPOD_URL || env.OLLAMA_URL || readPodUrlFile();
  if (apiKey && baseURL) {
    const model =
      readPodModelFile() ||
      env.LLM_MODEL ||
      (baseURL.includes('runpod') ? 'qwen2.5:14b-instruct' : 'gpt-4o-mini');
    return new RunpodProvider({ apiKey, baseURL, model });
  }
  if (env.GEMINI_API_KEY) {
    return new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.LLM_MODEL });
  }
  return new MockProvider(deterministicFallback);
}
