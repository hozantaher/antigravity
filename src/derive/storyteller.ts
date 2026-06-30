import { z } from 'zod';
import { StorySchema, NODE_ROLES, Story } from '../vektor.schema';
import { LlmProvider, completeStructured, LlmMessage } from '../llm/provider';
import { NodeBubble, bubbleToPrompt } from './context';

/**
 * Story synthesizer (P4) — nahrazuje stub `architect.ts:simulateLlmResponse`.
 *
 * Pro každý storyless uzel vyrobí narativu (pentáda + loreLine + promise + antiFeature + pillar + role)
 * z grounded context bubble (P3), omezenou projektovou severkou (pillar enum). Výstup projde:
 *   - Zod schématem (pillar ∈ enum, role ∈ enum, neprázdná pole) — completeStructured drop/retry,
 *   - grounding gate (narativa musí referencovat reálný symbol/soubor z uzlu — anti generická halucinace),
 *   - sibling-distinctness (promise se nesmí rovnat sourozenci — anti copy-paste).
 */

export interface Severka {
  pillars: string[]; // povolené brand-pilíře (z docs/story.md `smer`)
  lore: string; // logline/severka projektu
  voice?: string; // hlas (tone of voice)
}

export interface SiblingStory {
  id: string;
  promise?: string;
}

export interface StoryResult extends Story {
  role: (typeof NODE_ROLES)[number];
  grounded: boolean;
}

const BANNED_FILLER = [
  'bijící srdce',
  'obrněná stráž',
  'srdce modulu',
  'tep modulu',
  'mozek systému',
  'páteř aplikace',
];

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Narativa musí zmínit ≥1 reálný grounding token (symbol/soubor/id), ne být generická vata. */
export const isGrounded = (s: { loreLine: string; promise: string; identita: string }, bubble: NodeBubble): boolean => {
  const hay = norm(`${s.loreLine} ${s.promise} ${s.identita}`);
  const words = new Set(hay.split(' ').filter(Boolean));
  for (const tok of bubble.groundingTokens) {
    const t = norm(tok);
    if (t.length >= 3 && words.has(t)) return true;
  }
  return false;
};

const hasBannedFiller = (s: { loreLine: string; promise: string }): boolean => {
  const hay = `${s.loreLine} ${s.promise}`.toLowerCase();
  return BANNED_FILLER.some((b) => hay.includes(b));
};

/** Vyčistí narativu: model rád lepí emoji prefix a "(features/x)"/"(symbol: y)" kvůli grounding nudge. */
export const cleanNarrative = (s: string): string =>
  s
    .replace(/^[\s📖✨]+/u, '')
    .replace(/\s*\((?:features\/|spine\/|src\/|apps\/|symbol:|soubor:|\.\/)[^)]*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** Dynamické schéma: pillar omezený na severku, + role. */
export const makeStorySchema = (pillars: string[]) =>
  StorySchema.extend({
    pillar: z.enum(pillars.length ? (pillars as [string, ...string[]]) : ['general']),
    role: z.enum(NODE_ROLES),
  });

const buildMessages = (
  bubble: NodeBubble,
  severka: Severka,
  siblings: SiblingStory[],
): LlmMessage[] => {
  const system = [
    'Jsi autor "vektorů" — sémantických manifestů uzlů v byznys monorepu. Pro uzel napíšeš jeho příběh:',
    'identita (co uzel JE, 1 věta), smysl (proč existuje), smer (kam míří), duvod (byznys důvod),',
    'myslenka (jádrová teze), loreLine (📖 duše — charakter/metafora, 1 věta), promise (✨ slib — co',
    'konkrétně dodává, typicky "konzumuje X → produkuje Y"), antiFeature (co NESMÍ dělat — guardrail),',
    'pillar (jeden z povolených brand-pilířů), role (stage|primary|supporting|internal|voice).',
    '',
    `SEVERKA PROJEKTU: ${severka.lore}`,
    severka.voice ? `HLAS: ${severka.voice}` : '',
    `POVOLENÉ PILÍŘE (pillar musí být přesně jeden z nich): ${severka.pillars.join(', ')}`,
    '',
    'PRAVIDLA:',
    '- Piš česky, věcně, bez marketingového patosu a bez emoji v hodnotách.',
    '- loreLine a promise vycházej z reálné domény uzlu (VIN, kauce, faktura, příhoz, …), ale zmiň ji',
    '  PŘIROZENĚ ve větě — NIKDY nelep do textu cestu k souboru ani "(symbol: …)".',
    '- Žádné generické fráze ("bijící srdce modulu"). promise se MUSÍ lišit od sourozenců.',
    '- pillar vyber podle HLAVNÍ hodnoty uzlu; NEvybírej "transparency" jako automatický default —',
    '  většina uzlů podpírá jiný slib (serious-community, fair-price, curated, borderless).',
    '- Vrať POUZE JSON dle schématu.',
  ]
    .filter(Boolean)
    .join('\n');

  const sib = siblings.filter((s) => s.promise).map((s) => `- ${s.id}: "${s.promise}"`);
  const user = [
    'KONTEXT UZLU:',
    bubbleToPrompt(bubble),
    '',
    sib.length ? `SLIBY SOUROZENCŮ (tvůj promise musí být JINÝ):\n${sib.join('\n')}` : '',
    '',
    'Vrať JSON s klíči: identita, smysl, smer, duvod, myslenka, loreLine, promise, antiFeature, pillar, role.',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
};

export interface TellOptions {
  maxRetries?: number;
  timeoutMs?: number;
}

/** Vyrobí (a uzemní) story pro uzel. Vrátí null → uzel zůstane storyless (NIKDY se nezapíše vata). */
export async function tellStory(
  provider: LlmProvider,
  bubble: NodeBubble,
  severka: Severka,
  siblings: SiblingStory[] = [],
  opts: TellOptions = {},
): Promise<StoryResult | null> {
  const schema = makeStorySchema(severka.pillars);
  const messages = buildMessages(bubble, severka, siblings);
  const siblingPromises = new Set(siblings.map((s) => norm(s.promise ?? '')).filter(Boolean));

  const maxRetries = opts.maxRetries ?? 2;
  let convo = messages;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const out = await completeStructured(provider, convo, schema, {
      maxRetries: 0,
      timeoutMs: opts.timeoutMs,
    });
    if (!out) {
      // completeStructured už retryuje na úrovni JSON/schema; tady jen necháme doběhnout pokusy
      if (attempt === maxRetries) return null;
      continue;
    }
    const story = out as StoryResult;
    // čisticí krok: strip emoji prefix + path-paste artefakty
    story.loreLine = cleanNarrative(story.loreLine);
    story.promise = cleanNarrative(story.promise);
    story.identita = cleanNarrative(story.identita);
    // osa-root (stage) má deterministicky meta-pilíř napříč sliby (např. 'cross'), ne tematický
    if (bubble.role === 'stage' && severka.pillars.includes('cross')) story.pillar = 'cross';

    const dupSibling = siblingPromises.has(norm(story.promise));
    const filler = hasBannedFiller(story);
    const grounded = isGrounded(story, bubble);

    if (!dupSibling && !filler && grounded) {
      return { ...story, grounded: true };
    }

    if (attempt < maxRetries) {
      const reasons = [
        dupSibling ? 'promise je shodný se sourozencem — napiš jiný' : '',
        filler ? 'loreLine/promise je generická vata — vycházej z konkrétního kódu uzlu' : '',
        !grounded ? 'narativa nereferencuje žádný reálný symbol/soubor uzlu — zmiň konkrétní' : '',
      ].filter(Boolean);
      convo = [
        ...convo,
        { role: 'assistant', content: JSON.stringify(story) },
        { role: 'user', content: `Oprav: ${reasons.join('; ')}. Vrať POUZE opravený JSON.` },
      ];
      continue;
    }

    // poslední pokus: přijmeme, ale férově označíme grounded=false (nezahazujeme validní-ale-neuzemněné)
    if (!dupSibling && !filler) return { ...story, grounded };
    return null;
  }
  return null;
}
