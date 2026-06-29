import { describe, it, expect } from 'vitest';
import { VehicleSchema, LeadSchema, ArbitrageOpportunitySchema, ShadowDraftSchema } from './schemas';

describe('CORE: Zod Contract Boundary Tests', () => {
  it('VehicleSchema: Může mít vozidlo nesmyslný rok výroby?', () => {
    const invalidVehicle = {
      make: 'Škoda',
      model: 'Octavia',
      year: 1800, // Invalid, min 1900
      mileage: 100000
    };
    
    const result = VehicleSchema.safeParse(invalidVehicle);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('expected number to be >=1900');
    }
  });

  it('LeadSchema: Zachytí halucinace u zdroje dat?', () => {
    const invalidLead = {
      url: 'https://not-a-real-url',
      source: 'sbazar', // Neexistuje v enumu
      vehicle: {
        make: 'Volvo',
        model: 'FH16',
        year: 2020,
        mileage: 500000
      }
    };

    const result = LeadSchema.safeParse(invalidLead);
    expect(result.success).toBe(false);
  });

  it('ArbitrageOpportunitySchema: Dokáže ohlídat zápornou cenu?', () => {
    const invalidOpp = {
      id: 'opp-1',
      assetId: 'ext-123',
      price: -50000, // Halucinace (záporná cena)
      estimatedValue: 100000,
      expectedProfit: 150000,
      metadata: {}
    };

    const result = ArbitrageOpportunitySchema.safeParse(invalidOpp);
    expect(result.success).toBe(false);
  });

  it('ShadowDraftSchema: Vyžaduje správný formát uuid a emailu', () => {
    const draft = {
      draftId: 'not-a-uuid',
      contactEmail: 'not-an-email',
      opportunityId: 'opp-1',
      createdAt: new Date().toISOString(),
      status: 'pending'
    };

    const result = ShadowDraftSchema.safeParse(draft);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(1);
    }
  });
});
