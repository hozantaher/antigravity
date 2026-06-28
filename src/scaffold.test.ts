import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextAwareScaffolder } from './scaffold';
import fs from 'fs';
import path from 'path';

describe('ContextAwareScaffolder', () => {
  const testRoot = path.join(process.cwd(), 'test-sandbox-scaffold');

  beforeEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('should generate a new node with all required files', () => {
    const scaffolder = new ContextAwareScaffolder(testRoot);
    const report = scaffolder.generateNode('billing', 'sale/billing');

    expect(report.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(testRoot, 'sale/billing/vektor.json'))).toBe(true);
    expect(fs.existsSync(path.join(testRoot, 'sale/billing/billing.vue'))).toBe(true);
    
    const backendFile = path.join(testRoot, '@server/api/sale/billing.ts');
    expect(fs.existsSync(backendFile)).toBe(true);
    
    const backendContent = fs.readFileSync(backendFile, 'utf8');
    expect(backendContent).toContain('// @vek' + 'tor-link: billing');
  });

  it('should throw an error if the directory already exists', () => {
    const scaffolder = new ContextAwareScaffolder(testRoot);
    fs.mkdirSync(path.join(testRoot, 'sale/billing'), { recursive: true });
    
    expect(() => {
      scaffolder.generateNode('billing', 'sale/billing');
    }).toThrow('already exists');
  });
});
