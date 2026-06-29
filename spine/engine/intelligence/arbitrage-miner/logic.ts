import { Vehicle, ArbitrageOpportunity } from '../../../domain/core-types/schemas';

/**
 * Zhodnotí, zda je dané vozidlo arbitrážní příležitostí (na základě The Antigravity Matrix algoritmu).
 */
export function calculateArbitrageScore(
  target: { id: string; price: number; vehicle: Vehicle },
  marketCohort: { id: string; price: number; vehicle: Vehicle }[]
): ArbitrageOpportunity | null {
  
  // 1. Filtr ročníku +-1 (Srovnáváme s podobně starými auty)
  const cohort = marketCohort.filter(c => Math.abs(c.vehicle.year - target.vehicle.year) <= 1);
  if (cohort.length < 3) return null;
  
  // 2. Odstranění extrémů a vraků přes IQR (Interquartile Range)
  const prices = cohort.map(c => c.price).sort((a, b) => a - b);
  const q1 = prices[Math.floor(prices.length * 0.25)];
  const q3 = prices[Math.floor(prices.length * 0.75)];
  const iqr = q3 - q1;
  const cleanMarket = cohort.filter(c => c.price >= Math.max(0, q1 - 1.5 * iqr)); // vyhodí podhodnocené nesmysly/vraky

  if (cleanMarket.length < 2) return null;

  // 3. Spočítá dynamickou tržní cenu podle nájezdu (KNN - Nearest Neighbors)
  const getDist = (m: number) => Math.abs(m - target.vehicle.mileage);
  const peers = cleanMarket.sort((a, b) => getDist(a.vehicle.mileage) - getDist(b.vehicle.mileage)).slice(0, 3);
  const peerAvg = peers.reduce((sum, c) => sum + c.price, 0) / peers.length;

  // 4. Detekce arbitráže: Musí být 15% pod trhem, ale nesmí klesnout pod 60% průměru (ochrana před těžkými vraky)
  if (target.price <= peerAvg * 0.85 && target.price >= peerAvg * 0.60) {
    return {
      id: `opp-${target.id}`,
      assetId: target.id,
      price: target.price,
      estimatedValue: peerAvg,
      expectedProfit: peerAvg - target.price,
      metadata: {
        scoreMethod: "V10_AntigravityMatrix",
        peerCount: peers.length
      }
    };
  }

  return null;
}
