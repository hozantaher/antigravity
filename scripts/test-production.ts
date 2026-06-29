import 'dotenv/config';
import { CrawlerScheduler } from '../spine/demand/acquisition/deep-inventory/scheduler';
import { redisConnection } from '../spine/demand/acquisition/deep-inventory/queue';

async function testProduction() {
  const targetUrl = process.argv[2] || 'https://auto.bazos.cz/';
  console.log(`[Test] Odesílám manuální seed úlohu do BullMQ (Deep Crawler Queue) pro: ${targetUrl}`);
  
  await CrawlerScheduler.seedManual(targetUrl);
  
  console.log('[Test] Úloha úspěšně odeslána. Daemon worker by si ji měl nyní přečíst.');
  
  // Redis connection open by default in bullmq, let's just forcefully exit after a bit
  setTimeout(() => process.exit(0), 500);
}

testProduction().catch(console.error);
