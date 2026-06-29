import { describe, it, expect } from 'vitest';
import { calculateArbitrageScore } from './logic';

describe('BRAIN: Arbitrage Miner V10_AntigravityMatrix', () => {
  const baseVehicle = { make: 'Porsche', model: '911', year: 2021, mileage: 20000 };

  const market = [
    { id: 'm1', price: 2900000, vehicle: { ...baseVehicle, year: 2021, mileage: 20000 } },
    { id: 'm2', price: 2950000, vehicle: { ...baseVehicle, year: 2021, mileage: 15000 } },
    { id: 'm3', price: 2850000, vehicle: { ...baseVehicle, year: 2020, mileage: 30000 } },
    { id: 'm4', price: 3100000, vehicle: { ...baseVehicle, year: 2022, mileage: 10000 } },
    // Vrak (extrémně levné, odstraní se přes IQR)
    { id: 'w1', price: 1200000, vehicle: { ...baseVehicle, year: 2021, mileage: 15000 } },
  ];

  it('Ignoruje běžné nabídky (cena není dostatečně nízko)', () => {
    const target = { id: 't1', price: 2800000, vehicle: { ...baseVehicle, year: 2021, mileage: 18000 } };
    const result = calculateArbitrageScore(target, market);
    expect(result).toBeNull();
  });

  it('Identifikuje skutečnou arbitráž (20% pod trhem, ale ne vrak)', () => {
    // 2.35M je cca 20% pod trhem (průměr je kolem 2.9M)
    const target = { id: 't2', price: 2350000, vehicle: { ...baseVehicle, year: 2021, mileage: 18000 } };
    const result = calculateArbitrageScore(target, market);
    
    expect(result).not.toBeNull();
    expect(result?.expectedProfit).toBeGreaterThan(400000); // Zisk přes 400k CZK
    expect(result?.assetId).toBe('t2');
  });

  it('Zablokuje nákup zjevného vraku (příliš levné, např. bouračka)', () => {
    // 1.5M je moc levné (pod 60% trhu), past!
    const target = { id: 't3', price: 1500000, vehicle: { ...baseVehicle, year: 2021, mileage: 18000 } };
    const result = calculateArbitrageScore(target, market);
    
    // Algoritmus musí vrátit null, protože je to past.
    expect(result).toBeNull();
  });
});
