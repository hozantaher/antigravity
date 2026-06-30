import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { synthesize, loadSeverka } from './synthesize';
import { MockProvider } from '../llm/provider';
import { isStoryComplete } from '../vektor.schema';

const ROOT = path.join(process.cwd(), 'test-sandbox-synth');
const write = (rel: string, c: string) => {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, c);
};

// Dynamický mock: z promptu vytáhne první symbol a uzemní jím story (vždy validní + grounded).
const groundingMock = () =>
  new MockProvider((msgs) => {
    const text = msgs.map((m) => m.content).join('\n');
    const sym = (text.match(/EXPORTOVANÉ SYMBOLY:\s*([^\n,]+)/)?.[1] || 'kod').trim();
    return JSON.stringify({
      identita: `Uzel postavený kolem ${sym} a jeho odpovědnosti.`,
      smysl: `Drží jednu byznys odpovědnost přes ${sym}.`,
      smer: `Dotáhnout chování ${sym} do konce.`,
      duvod: `Bez ${sym} by tahle část nefungovala.`,
      myslenka: `${sym} je jádro tohoto uzlu.`,
      loreLine: `${sym} je tichý mechanismus, který drží slib uzlu.`,
      promise: `Konzumuje vstup a vydá výsledek přes ${sym}.`,
      antiFeature: `Obejít ${sym} a dělat věci načerno mimo kontrakt.`,
      pillar: 'value',
      role: 'primary',
    });
  });

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  write('features/sale/invoicing/vektor.json', JSON.stringify({ id: 'invoicing', story_axis: 'sale' }));
  write('features/sale/invoicing/invoice.ts', 'export const createInvoice = () => 1;');
  write('features/supply/vin/vektor.json', JSON.stringify({ id: 'vin', story_axis: 'supply' }));
  write('features/supply/vin/vin.ts', 'export const decodeVin = () => 2;');
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('loadSeverka', () => {
  it('fallback na generický default bez story.md', () => {
    const s = loadSeverka(ROOT);
    expect(s.pillars).toContain('value');
    expect(s.pillars.length).toBeGreaterThan(0);
  });
});

describe('synthesize (mock provider)', () => {
  it('dry-run: vyrobí validní kompletní story pro storyless uzly, nezapíše', async () => {
    const rep = await synthesize(ROOT, { provider: groundingMock(), write: false });
    expect(rep.totalNodes).toBe(2);
    expect(rep.storylessBefore).toBe(2);
    expect(rep.produced).toBe(2);
    expect(rep.validComplete).toBe(2);
    expect(rep.coverageBefore).toBe(0);
    expect(rep.coverageProjected).toBe(1);
    expect(rep.outcomes.every((o) => o.status === 'valid-dryrun')).toBe(true);
    // dry-run NEZAPSAL story
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'features/supply/vin/vektor.json'), 'utf-8'));
    expect(isStoryComplete(m)).toBe(false);
  });

  it('write: zapíše validní manifest s kompletní story', async () => {
    const rep = await synthesize(ROOT, { provider: groundingMock(), write: true });
    expect(rep.validComplete).toBe(2);
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'features/supply/vin/vektor.json'), 'utf-8'));
    expect(isStoryComplete(m)).toBe(true);
    expect(m.pillar).toBe('value');
    expect(m.loreLine).toContain('decodeVin');
    expect(m.id).toBe('vin'); // zachová existující strukturu
  });

  it('limit omezí počet zpracovaných uzlů', async () => {
    const rep = await synthesize(ROOT, { provider: groundingMock(), write: false, limit: 1 });
    expect(rep.attempted).toBe(1);
    expect(rep.validComplete).toBe(1);
  });
});
