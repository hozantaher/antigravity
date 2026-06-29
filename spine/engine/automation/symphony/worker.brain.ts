import { Worker } from 'bullmq';
import { redisConnection, handsQueue } from './queues';
import { LeadSchema } from '../../../domain/core-types';
import { calculateArbitrageScore } from '../../intelligence/arbitrage-miner';

// Dummy trh pro kalkulaci (V produkci se načítá z DB)
const DUMMY_MARKET = [
  { id: 'm1', price: 2900000, vehicle: { make: 'Porsche', model: '911', year: 2021, mileage: 20000 } },
  { id: 'm2', price: 2950000, vehicle: { make: 'Porsche', model: '911', year: 2021, mileage: 15000 } },
  { id: 'm3', price: 2850000, vehicle: { make: 'Porsche', model: '911', year: 2020, mileage: 30000 } }
];

export const brainWorker = new Worker('Q_BRAIN', async (job) => {
  console.log(`[Q_BRAIN] Přijat job: ${job.id}`);
  
  // 1. Zod Firewall: Pokud vstupní data nedávají smysl (halucinace ze scraperu), Worker zprávu odmítne.
  const lead = LeadSchema.parse(job.data);
  
  // 2. Kognice: Vypočítáme arbitráž
  const target = { id: job.id!, price: job.data.price || 0, vehicle: lead.vehicle };
  const opportunity = calculateArbitrageScore(target, DUMMY_MARKET);

  // 3. Rozhodnutí: Pokud to je dobrý deal, předáme ho levé hemisféře (HANDS)
  if (opportunity) {
    console.log(`[Q_BRAIN] Nalezena arbitráž! Zisk: ${opportunity.expectedProfit} CZK. Posílám do Q_HANDS.`);
    
    // Zde musíme předat i dealer email, bereme ho z leadu
    await handsQueue.add('dispatch-draft', { 
      opportunity, 
      dealerEmail: lead.dealerContact || 'unknown@dealer.com' 
    });
  } else {
    console.log(`[Q_BRAIN] Běžné auto, ignoruji.`);
  }
}, { connection: redisConnection });
