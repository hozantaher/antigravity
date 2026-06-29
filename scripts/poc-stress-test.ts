import { SymphonyQueue } from '../spine/engine/automation/symphony-queue/logic';
import { ArbitrageOpportunity } from '../spine/domain/core-types';
import { ShadowBroker } from '../spine/engine/drive/shadow-broker/broker';

async function runStressTest() {
  console.log('🚀 [Stress Test] Zahajuji injekci masivního objemu dat do SymphonyQueue...');
  
  // Aktivujeme brokera, ať naslouchá frontě (nastavili jsme mu concurrency 5)
  const broker = new ShadowBroker();
  
  const TOTAL_ITEMS = 100; // Počet položek pro PoC stress test
  const BATCH_SIZE = 20;

  console.log(`[Stress Test] Generuji ${TOTAL_ITEMS} příležitostí...`);
  
  const startTime = Date.now();
  let enqueued = 0;

  for (let i = 0; i < TOTAL_ITEMS; i += BATCH_SIZE) {
    const promises = [];
    for (let j = 0; j < BATCH_SIZE && (i + j) < TOTAL_ITEMS; j++) {
      const id = i + j;
      const op: ArbitrageOpportunity = {
        id: `stress_test_${id}`,
        assetId: `ext_${id}`,
        expectedProfit: Math.floor(Math.random() * 50000) + 10000,
        metadata: { price: 200000, title: `Test Auto ${id}` }
      };
      promises.push(SymphonyQueue.enqueue(op));
    }
    await Promise.all(promises);
    enqueued += promises.length;
    console.log(`[Stress Test] Enqueued ${enqueued}/${TOTAL_ITEMS}`);
  }

  const duration = Date.now() - startTime;
  console.log(`✅ [Stress Test] Injekce dokončena za ${duration} ms.`);
  console.log('⏳ [Stress Test] Sledujte logy ShadowBrokera níže (Broker asynchronně čistí frontu)...');

  // Počkáme pár sekund, abychom viděli logy konzumu z BullMQ
  setTimeout(() => {
    console.log('🏁 [Stress Test] Ukončuji PoC skript (Worker může jet dál na pozadí).');
    process.exit(0);
  }, 3000);
}

runStressTest().catch(console.error);
