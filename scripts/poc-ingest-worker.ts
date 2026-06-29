import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { ArbitrageMiner } from '../spine/engine/intelligence/arbitrage-miner/miner';
import { RawListing } from '../spine/domain/core-types';

const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

console.log('🎧 [Ingest POC] Worker is listening to "antigravity-ingest" queue...');

const worker = new Worker(
  'antigravity-ingest',
  async (job: Job) => {
    console.log(`\n📥 [Ingest POC] Received scraped listing from: ${job.data.source}`);
    
    // Zde mapujeme surová data ze scraperu na sjednocený typ RawListing
    const listing: RawListing = {
      id: job.data.item.mobile_id || `temp_${Date.now()}`,
      title: job.data.item.title || 'Unknown',
      make: job.data.item.make || 'Porsche', // Pro test
      model: job.data.item.model || '911',
      price: job.data.item.price_czk || 0,
      sourceUrl: job.data.item.url || 'http://example.com',
      year: job.data.item.year || 2021,
      mileage: job.data.item.mileage_km || 15000
    };

    console.log(`🔍 [Ingest POC] Predávám do pravé hemisféry (ArbitrageMiner): ${listing.title} za ${listing.price} CZK`);
    
    // Spustíme skutečnou inteligenci
    await ArbitrageMiner.evaluateAndRecord(listing);
    
    return { success: true, processedId: listing.id };
  },
  { connection: connection as any }
);

worker.on('failed', (job, err) => {
  console.error(`❌ [Ingest POC] Job failed with error: ${err.message}`);
});

process.on('SIGINT', async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
});
