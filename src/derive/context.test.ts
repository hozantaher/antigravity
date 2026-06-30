import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { crawlNodes } from './structure';
import { buildBubble, bubbleToPrompt, extractSymbols } from './context';

const ROOT = path.join(process.cwd(), 'test-sandbox-context');
const write = (rel: string, content: string) => {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  write('features/sale/invoicing/vektor.json', '{}');
  write(
    'features/sale/invoicing/invoice.ts',
    "import { decodeVin } from '../../supply/vin/vin';\nexport const createInvoice = () => decodeVin();\nexport class InvoiceRepo {}",
  );
  write('features/supply/vin/vektor.json', '{}');
  write(
    'features/supply/vin/vin.ts',
    'export const decodeVin = () => 2;\nexport type VinSpec = { make: string };',
  );
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('extractSymbols', () => {
  it('vytáhne const/class/type exporty', () => {
    const s = extractSymbols('export const a = 1;\nexport class B {}\nexport type C = string;', 'x.ts');
    expect(s).toEqual(expect.arrayContaining(['a', 'B', 'C']));
  });
  it('z .vue vezme jméno komponenty', () => {
    expect(extractSymbols('<template></template>', 'ItemCard.vue')).toContain('ItemCard');
  });
});

describe('buildBubble', () => {
  const nodes = () => crawlNodes(ROOT, { nodeStrategy: 'manifest' });

  it('symboly uzlu = reálné exporty z kódu', () => {
    const all = nodes();
    const vin = all.find((n) => n.id === 'vin')!;
    const b = buildBubble(vin, all, ROOT);
    expect(b.symbols).toEqual(expect.arrayContaining(['decodeVin', 'VinSpec']));
    expect(b.groundingTokens.has('decodevin')).toBe(true);
  });

  it('sousedé z edges (invoicing → vin) + jejich symboly', () => {
    const all = nodes();
    const inv = all.find((n) => n.id === 'invoicing')!;
    const b = buildBubble(inv, all, ROOT);
    expect(b.symbols).toEqual(expect.arrayContaining(['createInvoice', 'InvoiceRepo']));
    const nb = b.neighbors.find((n) => n.id === 'vin');
    expect(nb).toBeDefined();
    expect(nb!.symbols).toContain('decodeVin');
  });

  it('bubbleToPrompt obsahuje symboly i uzel', () => {
    const all = nodes();
    const inv = all.find((n) => n.id === 'invoicing')!;
    const text = bubbleToPrompt(buildBubble(inv, all, ROOT));
    expect(text).toContain('createInvoice');
    expect(text).toContain('UZEL: invoicing');
  });
});
