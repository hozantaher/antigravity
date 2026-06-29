import 'dotenv/config';
import { DeepInventoryScraper } from './spine/demand/acquisition/deep-inventory/scraper';

async function runPoc() {
  const url = process.argv[2] || 'https://auto.bazos.cz/';
  console.log(`[PoC] Spouštím Proof of Concept pro URL: ${url}\n`);
  
  const fs = require('fs');
  const hasTmpUrl = fs.existsSync('/tmp/runpod_llm_url');

  if (!process.env.OPENAI_API_KEY && !process.env.RUNPOD_API_KEY && !process.env.OLLAMA_URL && !hasTmpUrl) {
    console.warn('⚠️  POZOR: Nebyl detekován žádný LLM klíč (OPENAI_API_KEY, RUNPOD_API_KEY) ani OLLAMA_URL, ani nebyl nalezen běžící RunPod v /tmp/runpod_llm_url.');
    console.warn('   Testovací extrakce pomocí LLM pravděpodobně spadne kvůli chybějící autentizaci.');
    console.warn('   Pokud používáš RunPod, nastav RUNPOD_URL, nebo si nastartuj pod přes npx ts-node scripts/setup-pod-llm.ts');
  }

  const scraper = new DeepInventoryScraper();
  
  console.log(`[PoC] Inicializuji extrakci... může to pár vteřin trvat (Playwright načítá stránku).`);
  const { items } = await scraper.scrapeInventory(url);
  
  console.log('\n✅ Extrakce dokončena! Počet nalezených položek:', items.length);
  if (items.length > 0) {
    console.log(JSON.stringify(items.slice(0, 3), null, 2));
    if (items.length > 3) {
      console.log(`... a dalších ${items.length - 3} položek.`);
    }
  } else {
    console.log('Nebyla nalezena žádná auta. Buď stránka nic neobsahuje, nebo LLM nepochopil zadání / selhal klíč.');
  }
  
  // Násilně ukončíme proces (Playwright někdy drží smyčku, i když se zavře prohlížeč)
  process.exit(0);
}

runPoc().catch(err => {
  console.error('\n❌ Kritická chyba při provádění PoC:', err);
  process.exit(1);
});
