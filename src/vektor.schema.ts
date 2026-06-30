import { z } from 'zod';

/**
 * Runtime Zod validace pro `vektor.json` manifesty.
 *
 * Díra #6 z plánu: dnes engine konzumuje manifesty přes raw `JSON.parse(...) as VektorManifest`
 * (src/types.ts) — žádná runtime validace. Stroj, který manifesty *píše* (auto-derive), proto
 * potřebuje tvrdou bránu, aby do stromu nezapsal halucinaci LLM ani rozbitou strukturu.
 *
 * Existují dva dialekty (viz docs):
 *  - GRAPH dialekt  (antigravity src/types.ts): id, story_axis, semantic_layer, state, facets, edges…
 *  - SOUL  dialekt  (garaaage zlatý standard):  identita, smysl, smer, duvod, myslenka, pillar, role,
 *                                               loreLine, promise, antiFeature, proofSignal[], hotovo
 *
 * Proto dvě schémata:
 *  - VektorManifestSchema  — LENIENT (read): parsuje libovolný existující (i bordel) manifest bez pádu.
 *  - DerivedManifestSchema — STRICT  (write): co MUSÍ vyprodukovat auto-derive pro „kompletní" uzel.
 */

// ── Důkazní signál: napojení promise na reálný test/kód ──────────────────────
// garaaage používá stav 'pending'|'live', antigravity proofSignal 'pending'|'met' → tolerujeme obojí.
export const ProofSignalSchema = z.object({
  nazev: z.string(),
  zdroj: z.string(),
  stav: z.enum(['pending', 'met', 'live']),
});
export type ProofSignal = z.infer<typeof ProofSignalSchema>;

export const SEMANTIC_LAYERS = ['CORE', 'BODY', 'BRAIN', 'HANDS'] as const;
export const NODE_ROLES = ['stage', 'primary', 'supporting', 'internal', 'voice'] as const;
export const NODE_STATES = ['pending', 'met'] as const;

export type SemanticLayer = (typeof SEMANTIC_LAYERS)[number];
export type NodeRole = (typeof NODE_ROLES)[number];
export type NodeState = (typeof NODE_STATES)[number];

// ── LENIENT READ schema ──────────────────────────────────────────────────────
// Pozn.: zod ve výchozím nastavení *stripuje* neznámé klíče (legacy_metadata, hotovo, _review,
// vektorGate…), takže oba dialekty projdou; validují se jen typy známých polí.
// `smer` je na úrovni uzlu string, ale na úrovni app-severky pole → tolerujeme union.
export const VektorManifestSchema = z.object({
  // Graph dialekt
  id: z.string().optional(),
  story_axis: z.string().optional(),
  semantic_layer: z.string().optional(), // lenient: v datech existuje i stray "FEET"
  state: z.enum(NODE_STATES).optional(),
  facets: z.record(z.string(), z.array(z.string())).optional(),
  edges: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  origin: z.string().optional(),
  // Soul / narrative dialekt
  identita: z.string().optional(),
  smysl: z.string().optional(),
  smer: z.union([z.string(), z.array(z.string())]).optional(),
  duvod: z.string().optional(),
  myslenka: z.string().optional(),
  pillar: z.string().optional(),
  role: z.string().optional(),
  loreLine: z.string().optional(),
  promise: z.string().optional(),
  antiFeature: z.string().optional(),
  proofSignal: z.array(ProofSignalSchema).optional(),
  hotovo: z.union([z.boolean(), z.string()]).optional(),
});
export type VektorManifest = z.infer<typeof VektorManifestSchema>;

// ── STRICT story (to neredukovatelné, co píše LLM) ───────────────────────────
// Minimální délky brání prázdným/whitespace polím (první obrana proti halucinaci „.").
// `pillar` se navíc za běhu kontroluje proti enumu ze severky (storyteller, P4).
export const StorySchema = z.object({
  identita: z.string().trim().min(8),
  smysl: z.string().trim().min(8),
  smer: z.string().trim().min(4),
  duvod: z.string().trim().min(8),
  myslenka: z.string().trim().min(4),
  pillar: z.string().trim().min(2),
  loreLine: z.string().trim().min(8),
  promise: z.string().trim().min(8),
  antiFeature: z.string().trim().min(8),
});
export type Story = z.infer<typeof StorySchema>;

// ── STRICT WRITE schema — kompletní derivovaný uzel ──────────────────────────
export const DerivedManifestSchema = StorySchema.extend({
  id: z.string().min(1),
  story_axis: z.string().min(1),
  semantic_layer: z.enum(SEMANTIC_LAYERS),
  state: z.enum(NODE_STATES),
  role: z.enum(NODE_ROLES),
  facets: z.record(z.string(), z.array(z.string())),
  edges: z.array(z.string()),
  proofSignal: z.array(ProofSignalSchema),
  origin: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type DerivedManifest = z.infer<typeof DerivedManifestSchema>;

// ── Helpers ──────────────────────────────────────────────────────────────────
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

// Strukturální typ místo verzně-závislého z.ZodIssue / z.core.$ZodIssue.
const toErrors = (
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string[] => issues.map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`);

/** Lenient validace existujícího manifestu (read). */
export const validateManifest = (data: unknown): ValidationResult => {
  const r = VektorManifestSchema.safeParse(data);
  return r.success ? { ok: true, errors: [] } : { ok: false, errors: toErrors(r.error.issues) };
};

/** Strict validace strojem vyprodukovaného uzlu (write gate). */
export const validateDerived = (data: unknown): ValidationResult => {
  const r = DerivedManifestSchema.safeParse(data);
  return r.success ? { ok: true, errors: [] } : { ok: false, errors: toErrors(r.error.issues) };
};

/** „Complete Story" = má loreLine i promise (parita se story_coverage.py). */
export const isStoryComplete = (m: VektorManifest): boolean => Boolean(m.loreLine && m.promise);
