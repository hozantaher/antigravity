/**
 * Proof of Concept: 10 Různých algoritmů pro detekci Arbitráže (Podhodnocených aut)
 * Cíl: Odhalit nejlepší algoritmus, který umí odfiltrovat vraky, respektuje rok/nájezd a vybere jen skutečné příležitosti.
 */

// Generování mock dat pro "Porsche 911"
const mockMarket = [
  // Běžný trh (2020-2022, 10k-40k km)
  { id: 'n1', title: 'Normální', price: 2900000, year: 2021, mileage: 20000, isWreck: false, isArbitrage: false },
  { id: 'n2', title: 'Normální', price: 2950000, year: 2021, mileage: 15000, isWreck: false, isArbitrage: false },
  { id: 'n3', title: 'Normální', price: 2850000, year: 2020, mileage: 30000, isWreck: false, isArbitrage: false },
  { id: 'n4', title: 'Normální', price: 3100000, year: 2022, mileage: 10000, isWreck: false, isArbitrage: false },
  { id: 'n5', title: 'Normální', price: 2800000, year: 2020, mileage: 35000, isWreck: false, isArbitrage: false },
  
  // Vraky a pasti (Extrémně levné, ale pasti)
  { id: 'w1', title: 'Vrak - Motor KO', price: 1200000, year: 2021, mileage: 15000, isWreck: true, isArbitrage: false },
  { id: 'w2', title: 'Vrak - Bouračka', price: 1500000, year: 2022, mileage: 5000, isWreck: true, isArbitrage: false },

  // Skutečná arbitráž (Zoufalý prodejce, dědictví, exekuce - levné, ale dobré)
  { id: 'a1', title: 'Arbitráž 1', price: 2350000, year: 2021, mileage: 18000, isWreck: false, isArbitrage: true }, // -20% pod trhem
  { id: 'a2', title: 'Arbitráž 2', price: 2450000, year: 2021, mileage: 12000, isWreck: false, isArbitrage: true }, // -15% pod trhem
  
  // Úplně jiný segment (Stará auta) - testuje, zda algoritmus nemíchá jablka s hruškami
  { id: 'o1', title: 'Staré', price: 1100000, year: 2005, mileage: 150000, isWreck: false, isArbitrage: false },
  { id: 'o2', title: 'Staré', price: 950000, year: 2003, mileage: 180000, isWreck: false, isArbitrage: false },
];

const algorithms = {
  // 1. Hloupý průměr (Současný stav v miner.ts)
  "V1_DumbAverage": (market, target) => {
    const avg = market.reduce((sum, c) => sum + c.price, 0) / market.length;
    return target.price < avg * 0.85;
  },

  // 2. Průměr filtrovaný podle ročníku
  "V2_YearFilteredAverage": (market, target) => {
    const similar = market.filter(c => c.year === target.year);
    if (similar.length < 2) return false;
    const avg = similar.reduce((sum, c) => sum + c.price, 0) / similar.length;
    return target.price < avg * 0.85;
  },

  // 3. Grid Segmentace (Rok + Nájezd)
  "V3_GridSegmentation": (market, target) => {
    const isSimilarMileage = (m1, m2) => Math.abs(m1 - m2) <= 15000;
    const similar = market.filter(c => c.year === target.year && isSimilarMileage(c.mileage, target.mileage));
    if (similar.length < 2) return false;
    const avg = similar.reduce((sum, c) => sum + c.price, 0) / similar.length;
    return target.price < avg * 0.85;
  },

  // 4. IQR (Interquartile Range) Odstranění extrémů (vraků) před průměrováním
  "V4_IQR_Filtering": (market, target) => {
    const similar = market.filter(c => c.year === target.year);
    if (similar.length < 3) return false;
    const prices = similar.map(c => c.price).sort((a, b) => a - b);
    const q1 = prices[Math.floor(prices.length * 0.25)];
    const q3 = prices[Math.floor(prices.length * 0.75)];
    const iqr = q3 - q1;
    const validPrices = prices.filter(p => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
    if(validPrices.length === 0) return false;
    const avg = validPrices.reduce((s, p) => s + p, 0) / validPrices.length;
    return target.price < avg * 0.85;
  },

  // 5. Z-Score (Statistická odchylka)
  "V5_ZScore": (market, target) => {
    const similar = market.filter(c => Math.abs(c.year - target.year) <= 1);
    if (similar.length < 3) return false;
    const avg = similar.reduce((sum, c) => sum + c.price, 0) / similar.length;
    const variance = similar.reduce((sum, c) => sum + Math.pow(c.price - avg, 2), 0) / similar.length;
    const stdDev = Math.sqrt(variance);
    const zScore = (target.price - avg) / stdDev;
    return zScore <= -1.5 && zScore >= -3.0; 
  },

  // 6. Exponential Decay of Mileage (Cena degraduje s nájezdem)
  "V6_MileageDecayFormula": (market, target) => {
    const similar = market.filter(c => c.year === target.year);
    if (similar.length < 2) return false;
    const avgPrice = similar.reduce((sum, c) => sum + c.price, 0) / similar.length;
    const expectedPrice = avgPrice * (1 - (target.mileage / 500000));
    return target.price < expectedPrice * 0.85 && target.price > expectedPrice * 0.50;
  },

  // 7. K-Neareast Neighbors (KNN)
  "V7_KNN_Pricing": (market, target) => {
    const getDist = (c) => Math.abs(c.year - target.year) * 200000 + Math.abs(c.mileage - target.mileage);
    const sorted = [...market].filter(c => c.id !== target.id).sort((a, b) => getDist(a) - getDist(b));
    const neighbors = sorted.slice(0, 3);
    if (neighbors.length < 2) return false;
    const avg = neighbors.reduce((s, c) => s + c.price, 0) / neighbors.length;
    return target.price < avg * 0.85 && target.price > avg * 0.5;
  },

  // 8. Hybrid (Grid + Z-Score Ochrana proti vraku)
  "V8_HybridGridZScore": (market, target) => {
    const isSimilarMileage = (m1, m2) => Math.abs(m1 - m2) <= 15000;
    const similar = market.filter(c => c.year === target.year && isSimilarMileage(c.mileage, target.mileage));
    if (similar.length < 2) return false;
    const avg = similar.reduce((sum, c) => sum + c.price, 0) / similar.length;
    const variance = similar.reduce((sum, c) => sum + Math.pow(c.price - avg, 2), 0) / similar.length;
    const stdDev = Math.sqrt(variance) || 1;
    const zScore = (target.price - avg) / stdDev;
    return target.price < avg * 0.88 && zScore >= -2.5;
  },

  // 9. Mediane Filtering
  "V9_MedianFilter": (market, target) => {
    const similar = market.filter(c => c.year === target.year);
    if (similar.length < 2) return false;
    const prices = similar.map(c => c.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    return target.price < median * 0.85 && target.price > median * 0.55;
  },

  // 10. The Antigravity Matrix (Vektorová multi-dimenzionální heuristika)
  "V10_AntigravityMatrix": (market, target) => {
    const cohort = market.filter(c => Math.abs(c.year - target.year) <= 1);
    if (cohort.length < 3) return false;
    const prices = cohort.map(c => c.price).sort((a, b) => a - b);
    const q1 = prices[Math.floor(prices.length * 0.25)];
    const q3 = prices[Math.floor(prices.length * 0.75)];
    const iqr = q3 - q1;
    const cleanMarket = cohort.filter(c => c.price >= q1 - 1.5 * iqr); 
    if (cleanMarket.length < 2) return false;
    const getDist = (c) => Math.abs(c.mileage - target.mileage);
    const peers = cleanMarket.sort((a, b) => getDist(a) - getDist(b)).slice(0, 3);
    const peerAvg = peers.reduce((s, c) => s + c.price, 0) / peers.length;
    return target.price <= peerAvg * 0.88 && target.price >= peerAvg * 0.65; // Arbitráž je max 35% pod trhem
  }
};

console.log('🧪 Spouštím Proof of Concept pro 10 verzí Arbitrage Mineru\n');

Object.entries(algorithms).forEach(([name, algo]) => {
  let truePositives = 0; 
  let falsePositives = 0; 
  let falseNegatives = 0; 

  mockMarket.forEach(car => {
    const marketKnowledge = mockMarket.filter(c => c.id !== car.id);
    const isFlaggedAsArbitrage = algo(marketKnowledge, car);

    if (isFlaggedAsArbitrage && car.isArbitrage) truePositives++;
    if (isFlaggedAsArbitrage && !car.isArbitrage) falsePositives++;
    if (!isFlaggedAsArbitrage && car.isArbitrage) falseNegatives++;
  });

  const precision = truePositives / (truePositives + falsePositives || 1);
  const recall = truePositives / (truePositives + falseNegatives || 1);
  const f1 = 2 * ((precision * recall) / (precision + recall || 1));

  let scoreColor = f1 === 1 ? '🟩' : f1 >= 0.7 ? '🟨' : '🟥';
  
  console.log(`${scoreColor} [${name}]`);
  console.log(`   Pravá Arbitráž (Nalezeno): ${truePositives}/2`);
  console.log(`   Falešný poplach (Koupil by vrak): ${falsePositives}`);
  console.log(`   Score (F1): ${f1.toFixed(2)}\n`);
});
