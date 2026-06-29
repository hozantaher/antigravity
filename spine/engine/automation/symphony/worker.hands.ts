import { Worker } from 'bullmq';
import { redisConnection } from './queues';
import { ArbitrageOpportunitySchema } from '../../../domain/core-types';
import { dispatchShadowDraft } from '../../drive/shadow-broker';
import { z } from 'zod';

const PayloadSchema = z.object({
  opportunity: ArbitrageOpportunitySchema,
  dealerEmail: z.string().email()
});

export const handsWorker = new Worker('Q_HANDS', async (job) => {
  console.log(`[Q_HANDS] Přijat job pro oslovení: ${job.id}`);
  
  // 1. Zod Firewall: Opět kontrolujeme, že BRAIN neposlal halucinaci.
  const { opportunity, dealerEmail } = PayloadSchema.parse(job.data);

  // 2. Exekuce: Odeslání emailu a vytvoření Shadow Draftu.
  // Zde se volá funkce, která je v testech namockována (SMTP Sandbox).
  const draft = await dispatchShadowDraft(opportunity, dealerEmail);
  
  console.log(`[Q_HANDS] Úspěch! Email odeslán. Magický odkaz čeká: ${draft.draftId}`);
}, { 
  connection: redisConnection,
  limiter: {
    max: 5, // Maximálně 5 mailů za sekundu (Ochrana proti SMTP banu)
    duration: 1000
  }
});
