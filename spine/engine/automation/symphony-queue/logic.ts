import { EventEmitter } from 'events';

// Centrální událostní sběrnice (v produkci nahrazeno např. Redis/BullMQ)
export const symphonyBus = new EventEmitter();

export interface ArbitrageOpportunity {
  id: string;
  assetId: string;
  expectedProfit: number;
  metadata: Record<string, any>;
}

export class SymphonyQueue {
  /**
   * Pravá hemisféra (Miner) volá tuto metodu pro zařazení příležitosti.
   */
  static enqueue(opportunity: ArbitrageOpportunity) {
    console.log(`[SymphonyQueue] Enqueued opportunity: ${opportunity.id} (Profit: ${opportunity.expectedProfit})`);
    symphonyBus.emit('opportunity_ready', opportunity);
  }

  /**
   * Levá hemisféra (Broker) volá tuto metodu pro přihlášení k odběru a zpracování.
   */
  static subscribe(handler: (op: ArbitrageOpportunity) => Promise<void>) {
    symphonyBus.on('opportunity_ready', async (op: ArbitrageOpportunity) => {
      try {
        await handler(op);
        console.log(`[SymphonyQueue] Opportunity ${op.id} processed successfully.`);
      } catch (error) {
        console.error(`[SymphonyQueue] Error processing opportunity ${op.id}:`, error);
        // Zde by byla logika pro přesun do Dead Letter Queue (DLQ)
      }
    });
  }
}
