import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { assessStructure, materializeStructure } from './migrate';
import { isStoryComplete, validateManifest } from '../vektor.schema';

const ROOT = path.join(process.cwd(), 'test-sandbox-migrate');
const w = (rel: string, c: string) => {
  const f = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, c);
};

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  // syrový repo: kód, ale ŽÁDNÉ vektor.json
  w('features/sale/invoicing/invoice.ts', 'export const createInvoice = () => 1;');
  w('features/supply/vin/vin.ts', 'export const decodeVin = () => 2;');
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('assessStructure (Fáze A — zaštěrkat)', () => {
  it('repo bez manifestů → unmigrated', () => {
    const a = assessStructure(ROOT);
    expect(a.state).toBe('unmigrated');
    expect(a.codeNodes).toBeGreaterThanOrEqual(2);
    expect(a.manifestNodes).toBe(0);
    expect(a.alreadyMigrated).toBe(false);
  });
});

describe('materializeStructure (Fáze B — změnit strukturu)', () => {
  it('dry-run nic nezapíše, jen naplánuje', () => {
    const m = materializeStructure(ROOT, { write: false });
    expect(m.created.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(ROOT, 'features/supply/vin/vektor.json'))).toBe(false);
  });

  it('write vytvoří structure-only manifesty (bez story); pak je struktura migrated', () => {
    const m = materializeStructure(ROOT, { write: true });
    expect(m.created.length).toBeGreaterThanOrEqual(2);

    const mp = path.join(ROOT, 'features/supply/vin/vektor.json');
    const manifest = JSON.parse(fs.readFileSync(mp, 'utf-8'));
    expect(validateManifest(manifest).ok).toBe(true);
    expect(manifest.story_axis).toBe('supply');
    expect(manifest.state).toBeDefined();
    expect(isStoryComplete(manifest)).toBe(false); // story až ve Fázi C

    expect(assessStructure(ROOT).state).toBe('migrated');
  });

  it('idempotence: druhý běh vše přeskočí', () => {
    materializeStructure(ROOT, { write: true });
    const m2 = materializeStructure(ROOT, { write: true });
    expect(m2.created.length).toBe(0);
    expect(m2.skipped.length).toBeGreaterThanOrEqual(2);
  });

  it('NEPŘEPÍŠE existující manifest se story (chrání story)', () => {
    const dir = path.join(ROOT, 'features/sale/invoicing');
    fs.writeFileSync(
      path.join(dir, 'vektor.json'),
      JSON.stringify({ id: 'invoicing', loreLine: 'L', promise: 'P' }),
    );
    materializeStructure(ROOT, { write: true });
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'vektor.json'), 'utf-8'));
    expect(after.loreLine).toBe('L');
    expect(after.promise).toBe('P');
  });
});
