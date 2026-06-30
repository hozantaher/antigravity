import { describe, it, expect } from 'vitest';
import {
  validateManifest,
  validateDerived,
  isStoryComplete,
  StorySchema,
  DerivedManifestSchema,
} from './vektor.schema';

// Reálné tvary z repa (zkráceno) — nesmí pohnout test ke spadnutí na neznámých klíčích.

describe('VektorManifestSchema (lenient read)', () => {
  it('projde GRAPH dialekt (antigravity shadow-broker)', () => {
    const m = {
      id: 'shadow-broker',
      story_axis: 'engine',
      semantic_layer: 'HANDS',
      state: 'met',
      facets: { logic: ['./broker.ts', './logic.ts'], tests: ['./broker.test.ts'] },
      edges: ['symphony-queue', 'core-types'],
      loreLine: 'Levá hemisféra: Stínový vyjednavač.',
      promise: 'Konzumuje ArbitrageOpportunities a generuje Magic Linky.',
    };
    expect(validateManifest(m).ok).toBe(true);
  });

  it('projde SOUL dialekt (garaaage sale — bez id, s extra klíči)', () => {
    const m = {
      identita: 'Prodej — osa páteře: konverze hodnoty na peníze.',
      smysl: 'Sdružuje domény, které inkasují.',
      smer: 'Dovést transakci k zaplacení.',
      duvod: 'Tady se dělají peníze.',
      myslenka: 'Prodej je osa, ne náhoda.',
      pillar: 'cross',
      role: 'stage',
      promise: 'Co se vydraží, to se i zaplatí.',
      loreLine: 'Osa prodeje — depozit, settlement a provize.',
      proofSignal: [{ nazev: 'sale-axis-rollup', zdroj: 'vektor-tree', stav: 'pending' }],
      antiFeature: 'Osa bez společného prodejního smyslu.',
      hotovo: true, // neznámý klíč pro strict, ale lenient ho ignoruje
    };
    expect(validateManifest(m).ok).toBe(true);
  });

  it('toleruje stray semantic_layer a smer jako pole (app-severka)', () => {
    expect(validateManifest({ semantic_layer: 'FEET' }).ok).toBe(true);
    expect(validateManifest({ smer: ['transparency', 'fair-price'] }).ok).toBe(true);
  });

  it('FAILuje na špatném typu (state mimo enum, edges není pole)', () => {
    expect(validateManifest({ state: 'bogus' }).ok).toBe(false);
    expect(validateManifest({ edges: 'symphony-queue' }).ok).toBe(false);
    const r = validateManifest({ proofSignal: [{ nazev: 'x', zdroj: 'y', stav: 'WUT' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/proofSignal/);
  });
});

describe('isStoryComplete', () => {
  it('true jen když má loreLine i promise', () => {
    expect(isStoryComplete({ loreLine: 'a', promise: 'b' })).toBe(true);
    expect(isStoryComplete({ loreLine: 'a' })).toBe(false);
    expect(isStoryComplete({ promise: 'b' })).toBe(false);
    expect(isStoryComplete({})).toBe(false);
  });
});

describe('DerivedManifestSchema (strict write gate)', () => {
  const complete = {
    id: 'sale-settlement',
    story_axis: 'sale',
    semantic_layer: 'HANDS',
    state: 'pending',
    role: 'primary',
    facets: { logic: ['./settle.ts'] },
    edges: ['deposit-billing'],
    proofSignal: [{ nazev: 'settle test', zdroj: 'test/settle', stav: 'pending' }],
    identita: 'Vypořádání prodeje po skončení aukce.',
    smysl: 'Dokončí převod peněz i vlastnictví výherci.',
    smer: 'charge-once, amount-due přesně.',
    duvod: 'Bez vypořádání není dokončený obchod.',
    myslenka: 'Prodej končí až penězi.',
    pillar: 'serious-community',
    loreLine: 'Poslední stisk ruky — peníze i klíče mění majitele.',
    promise: 'Co se vydraží, to se i vypořádá do koruny.',
    antiFeature: 'Settlement bez idempotence — dvojí stržení.',
  };

  it('projde kompletní derivovaný uzel', () => {
    expect(validateDerived(complete).ok).toBe(true);
  });

  it('FAILuje když chybí struktura (story_axis)', () => {
    const { story_axis, ...rest } = complete;
    expect(validateDerived(rest).ok).toBe(false);
  });

  it('FAILuje na špatném role / semantic_layer', () => {
    expect(validateDerived({ ...complete, role: 'overlord' }).ok).toBe(false);
    expect(validateDerived({ ...complete, semantic_layer: 'FEET' }).ok).toBe(false);
  });

  it('FAILuje na prázdné/příliš krátké story (anti-halucinace)', () => {
    expect(validateDerived({ ...complete, loreLine: '.' }).ok).toBe(false);
    expect(validateDerived({ ...complete, promise: '   ' }).ok).toBe(false);
    expect(StorySchema.safeParse({ ...complete }).success).toBe(true);
  });
});
