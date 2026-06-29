// @vektor-link: arbitrage-miner

export interface CarData {
  id: string;
  rawText: string;
  priceCZK: number;
}

export interface ArbitrageResult {
  id: string;
  rawDelta: number;
  profitMargin: number;
  expectedFinalPrice: number;
  expectedDelta: number;
  action: 'IGNORE' | 'EXECUTE';
}

// 1. KROK: Rychlá extrakce parametrů lokálním modelem (SLM)
async function extractFeatures(car: CarData) {
  // Simulace lokální Ollama / SLM extrakce
  return {
    make: "Skoda",
    model: "Octavia",
    year: 2020,
    mileage: 85000,
  };
}

// 2. KROK: Vector Search v naší historické databázi (pgvector)
async function getHistoricalBaseline(features: any) {
  // Simulace hledání tržního baselinu přes embeddingy
  const marketValue = 450000; 
  return marketValue;
}

// 3. KROK: Sentiment & Urgency Analysis (Hledání zoufalství)
async function analyzeUrgency(text: string) {
  let urgencyScore = 1.0; 
  const lowerText = text.toLowerCase();
  
  if (lowerText.includes("spěchá") || lowerText.includes("rychlé jednání")) urgencyScore -= 0.05;
  if (lowerText.includes("stěhování") || lowerText.includes("rozvod")) urgencyScore -= 0.10;
  if (lowerText.includes("sleva") && lowerText.includes("dnes")) urgencyScore -= 0.05;

  return urgencyScore;
}

export default async function evaluateArbitrage(incomingLead: CarData): Promise<ArbitrageResult> {
  const features = await extractFeatures(incomingLead);
  const baselineValue = await getHistoricalBaseline(features);
  const urgency = await analyzeUrgency(incomingLead.rawText);

  // Výpočet čisté arbitráže a marže
  const rawDelta = baselineValue - incomingLead.priceCZK;
  const profitMargin = (rawDelta / baselineValue) * 100;

  // Aplikace Urgency
  const expectedFinalPrice = incomingLead.priceCZK * urgency;
  const expectedDelta = baselineValue - expectedFinalPrice;
  
  // Rozhodovací engine
  const action = expectedDelta > 50000 ? 'EXECUTE' : 'IGNORE';

  return {
    id: incomingLead.id,
    rawDelta,
    profitMargin,
    expectedFinalPrice,
    expectedDelta,
    action
  };
}
