import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../vitest.setup';
import { RunpodProvider } from '../llm/provider';
import { tellStory, isGrounded, makeStorySchema, Severka } from './storyteller';
import { NodeBubble } from './context';

const RUNPOD_URL = 'https://fake-pod.runpod.net/v1';
const CHAT = `${RUNPOD_URL}/chat/completions`;
const provider = () => new RunpodProvider({ apiKey: 'k', baseURL: RUNPOD_URL, model: 'qwen2.5:14b-instruct' });

const reply = (content: string) =>
  HttpResponse.json({
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'q',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const bubble: NodeBubble = {
  id: 'invoicing',
  path: 'features/sale/invoicing',
  story_axis: 'sale',
  role: 'supporting',
  semantic_layer: 'HANDS',
  files: ['./invoice.ts'],
  symbols: ['createInvoice', 'InvoiceRepo'],
  neighbors: [],
  snippet: 'export const createInvoice = () => {}',
  groundingTokens: new Set(['invoicing', 'createinvoice', 'invoicerepo', 'invoice']),
};

const severka: Severka = {
  pillars: ['transparency', 'serious-community', 'fair-price'],
  lore: 'Evropská aukce vozidel na otevřených papírech.',
  voice: 'věcný, důvěryhodný',
};

const story = (o: Record<string, string> = {}) =>
  JSON.stringify({
    identita: 'Fakturace — daňový doklad ke každé platbě v systému.',
    smysl: 'Aby každá platba měla dohledatelný doklad pro účetnictví.',
    smer: 'Doklad přes Fakturoid: proforma i řádná faktura.',
    duvod: 'Bez dokladu není důvěra ani účetnictví.',
    myslenka: 'Každá platba má svůj papír.',
    loreLine: 'createInvoice promění platbu v dohledatelný daňový doklad.',
    promise: 'Za každou platbu dostaneš dohledatelný daňový doklad.',
    antiFeature: 'Platba bez faktury — peníze bez papíru.',
    pillar: 'serious-community',
    role: 'primary',
    ...o,
  });

describe('makeStorySchema', () => {
  it('omezí pillar na severku', () => {
    const s = makeStorySchema(['transparency', 'fair-price']);
    expect(s.safeParse(JSON.parse(story({ pillar: 'transparency' }))).success).toBe(true);
    expect(s.safeParse(JSON.parse(story({ pillar: 'mimo-enum' }))).success).toBe(false);
  });
});

describe('isGrounded', () => {
  it('true když narativa zmíní reálný symbol', () => {
    expect(isGrounded({ loreLine: 'createInvoice dělá doklad', promise: 'x', identita: 'y' }, bubble)).toBe(true);
  });
  it('false u generické vaty', () => {
    expect(isGrounded({ loreLine: 'Obecná abstraktní vrstva', promise: 'cosi', identita: 'něco' }, bubble)).toBe(false);
  });
});

describe('tellStory (P4)', () => {
  it('vrátí grounded story při validním uzemněném výstupu', async () => {
    server.use(http.post(CHAT, () => reply(story())));
    const out = await tellStory(provider(), bubble, severka, []);
    expect(out).not.toBeNull();
    expect(out!.pillar).toBe('serious-community');
    expect(out!.role).toBe('primary');
    expect(out!.grounded).toBe(true);
    expect(out!.promise).toMatch(/doklad/);
  });

  it('DROP → null při pillar mimo severku (Zod)', async () => {
    server.use(http.post(CHAT, () => reply(story({ pillar: 'curated' })))); // není v severce
    const out = await tellStory(provider(), bubble, severka, [], { maxRetries: 1 });
    expect(out).toBeNull();
  });

  it('odmítne copy-paste sourozencova promise', async () => {
    const dup = 'Za každou platbu dostaneš dohledatelný daňový doklad.';
    server.use(http.post(CHAT, () => reply(story({ promise: dup }))));
    const out = await tellStory(provider(), bubble, severka, [{ id: 'sibling', promise: dup }], {
      maxRetries: 1,
    });
    expect(out).toBeNull();
  });

  it('odmítne banální filler ("bijící srdce")', async () => {
    server.use(http.post(CHAT, () => reply(story({ loreLine: 'Bijící srdce modulu plné energie.' }))));
    const out = await tellStory(provider(), bubble, severka, [], { maxRetries: 1 });
    expect(out).toBeNull();
  });

  it('neuzemněnou-ale-validní přijme s grounded=false (nezahazuje poezii)', async () => {
    server.use(
      http.post(CHAT, () =>
        reply(story({ loreLine: 'Tichý strážce řádu a klidu.', promise: 'Drží pořádek v účtech férově.' })),
      ),
    );
    const out = await tellStory(provider(), bubble, severka, [], { maxRetries: 1 });
    expect(out).not.toBeNull();
    expect(out!.grounded).toBe(false);
  });
});
