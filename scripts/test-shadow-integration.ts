import { SymphonyQueue } from '../spine/engine/automation/symphony-queue/index';
import { ArbitrageMiner } from '../spine/engine/intelligence/arbitrage-miner/miner';
import { ShadowBroker } from '../spine/engine/drive/shadow-broker/broker';

async function runTest() {
  console.log('🚀 Zahajuji Test: Zero-Downtime Stínová Integrace');

  // Inicializujeme ShadowBroker, který se napojí na SymphonyQueue a Garaaage DB
  const broker = new ShadowBroker();

  // Simulujeme data, která by běžně přišla z mobile-de scraperu
  const testListing = {
    id: 'test-car-123',
    sourceUrl: 'https://mobile.de/test-car-123',
    title: 'Porsche 911 Carrera 4S (Shadow Test)',
    price: 2500000,
    make: 'Porsche',
    model: '911',
    year: 2021,
    mileage: 15000
  };

  console.log('\n[1] Scraper odesílá data do Arbitrage Mineru...');
  
  // Přímé vyhodnocení Mineru, který to pošle do SymphonyQueue
  await ArbitrageMiner.evaluateAndRecord(testListing);

  console.log('\n⏳ Čekám 3 sekundy na asynchronní zpracování v SymphonyQueue...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('\n✅ Test dokončen. Zkontroluj tabulku "items" v produkční databázi Garaaage.');
  process.exit(0);
}

runTest().catch(console.error);
