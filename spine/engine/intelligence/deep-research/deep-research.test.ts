import { describe, it, expect } from 'vitest';
import { deepResearchMiner } from './index';
import { RawListing } from '../../../domain/core-types/index';

describe('Deep Research Miner', () => {

  const baseListing: RawListing = {
    id: 'test_123',
    title: 'Skoda Octavia 2.0 TDI',
    price: 150000,
    sourceUrl: 'https://example.com/auto',
    make: 'Skoda',
    model: 'Octavia',
    mileage: 200000,
    year: 2016
  };

  it('Měl by detekovat běžný inzerát (žádné riziko, žádné zoufalství)', async () => {
    const listing = {
      ...baseListing,
      description: 'Dobrý den, prodám udržovanou Octavii. Olej měněn pravidelně. Garážované.'
    };
    
    const result = await deepResearchMiner.analyzeListing(listing);
    
    expect(result.riskScore).toBe(0);
    expect(result.desperationScore).toBe(0);
    expect(result.isArbitrage).toBe(false);
    expect(result.hiddenFlaws.length).toBe(0);
  });

  it('Měl by detekovat vysoké riziko a zamítnout arbitráž (Past)', async () => {
    const listing = {
      ...baseListing,
      description: 'Prodám Škoda Octavia. Motor trochu klepe a svítí kontrolka motoru. Nějaká koroze tam je, ale nic hrozného.'
    };
    
    const result = await deepResearchMiner.analyzeListing(listing);
    
    expect(result.riskScore).toBeGreaterThanOrEqual(50);
    expect(result.desperationScore).toBe(0);
    expect(result.isArbitrage).toBe(false);
    expect(result.hiddenFlaws).toContain('klepe');
    expect(result.hiddenFlaws).toContain('svítí');
    expect(result.hiddenFlaws).toContain('koroze');
  });

  it('Měl by detekovat vysoké zoufalství a potvrdit arbitráž (Zlatá žíla)', async () => {
    const listing = {
      ...baseListing,
      description: 'Auto je v top stavu. Spěchá to! Z rodinných důvodů prodávám rychle, překáží mi. Při rychlém jednání výrazná sleva, dohoda jistá.'
    };
    
    const result = await deepResearchMiner.analyzeListing(listing);
    
    expect(result.riskScore).toBe(0);
    expect(result.desperationScore).toBeGreaterThanOrEqual(50);
    expect(result.isArbitrage).toBe(true);
  });

  it('Měl by zamítnout zoufalého prodejce, pokud je auto vrak', async () => {
    const listing = {
      ...baseListing,
      description: 'Rychlé jednání - spěchá! Prodám na díly, auto je havarované a bez stk.'
    };
    
    const result = await deepResearchMiner.analyzeListing(listing);
    
    expect(result.riskScore).toBeGreaterThan(50); // Ha! 'na díly', 'havarované', 'bez stk' -> 75%
    expect(result.desperationScore).toBeGreaterThan(50); // 'spěchá', 'rychlé jednání' -> 60%
    // Pravidlo RegexStrategy: isArbitrage: desperation > 50 && risk < 30
    expect(result.isArbitrage).toBe(false); 
  });
});
