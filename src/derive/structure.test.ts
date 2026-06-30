import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { crawlNodes, deriveAxis } from './structure';

const ROOT = path.join(process.cwd(), 'test-sandbox-derive');

const write = (rel: string, content: string) => {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  // malý fake repo: osa-root + 2 listové uzly, jeden import napříč osami
  write('features/sale/vektor.json', '{}');
  write('features/sale/settle.ts', 'export const settle = () => 1;');
  write('features/sale/invoicing/vektor.json', '{}');
  write(
    'features/sale/invoicing/invoice.ts',
    "import { decodeVin } from '../../supply/vin/vin';\nexport const invoice = () => decodeVin();",
  );
  write('features/sale/invoicing/invoice.test.ts', "import './invoice';");
  write('features/supply/vin/vektor.json', '{}');
  write('features/supply/vin/vin.ts', 'export const decodeVin = () => 2;');
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('deriveAxis', () => {
  it('najde osu kdekoliv v cestě (features/<axis>/…)', () => {
    expect(deriveAxis('features/sale/invoicing', ['demand', 'supply', 'sale'])).toBe('sale');
    expect(deriveAxis('spine/supply/vin', ['supply'])).toBe('supply');
  });
});

describe('crawlNodes (manifest strategy)', () => {
  const nodes = () => crawlNodes(ROOT, { nodeStrategy: 'manifest' });

  it('objeví všechny 3 uzly s vektor.json', () => {
    const ids = nodes()
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual(['invoicing', 'sale', 'vin']);
  });

  it('osa-root → role stage; osa + semantic_layer dle mapy', () => {
    const sale = nodes().find((n) => n.id === 'sale')!;
    expect(sale.role).toBe('stage');
    expect(sale.story_axis).toBe('sale');
    expect(sale.semantic_layer).toBe('HANDS');
  });

  it('facety dle přípony + proofSignal/state z testů', () => {
    const inv = nodes().find((n) => n.id === 'invoicing')!;
    expect(inv.facets.logic).toContain('./invoice.ts');
    expect(inv.facets.tests).toContain('./invoice.test.ts');
    expect(inv.state).toBe('met');
    expect(inv.proofSignal).toHaveLength(1);
    expect(inv.story_axis).toBe('sale');
  });

  it('edges z cross-node importu (invoicing → vin)', () => {
    const inv = nodes().find((n) => n.id === 'invoicing')!;
    expect(inv.edges).toContain('vin');
    const vin = nodes().find((n) => n.id === 'vin')!;
    expect(vin.inDegree).toBe(1);
    expect(vin.story_axis).toBe('supply');
    expect(vin.semantic_layer).toBe('BODY');
  });
});

describe('crawlNodes (heuristic strategy — bez manifestů)', () => {
  it('najde uzly z přítomnosti zdrojových souborů', () => {
    // smaž manifesty → simuluj repo bez vektor.json
    for (const f of ['features/sale/vektor.json', 'features/sale/invoicing/vektor.json', 'features/supply/vin/vektor.json'])
      fs.rmSync(path.join(ROOT, f), { force: true });
    const ids = crawlNodes(ROOT, { nodeStrategy: 'heuristic' })
      .map((n) => n.id)
      .sort();
    expect(ids).toContain('vin');
    expect(ids).toContain('invoicing');
    expect(ids.length).toBeGreaterThanOrEqual(3);
  });
});
