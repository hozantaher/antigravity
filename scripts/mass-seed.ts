import { CrawlerScheduler } from '../spine/demand/acquisition/deep-inventory/scheduler';

async function run() {
  console.log('[MassSeed] Zahajuji injekci stránek do CrawlerQueue pro Bazoš...');
  
  // Bazos stránkuje po 20 inzerátech. Pro test dáme např. prvních 50 stránek (1000 aut)
  for (let i = 0; i < 50; i++) {
    const offset = i * 20;
    const url = offset === 0 ? 'https://auto.bazos.cz/' : `https://auto.bazos.cz/${offset}/`;
    await CrawlerScheduler.seedManual(url);
    console.log(`[MassSeed] Zaseto: ${url}`);
  }
  
  console.log('[MassSeed] Injekce dokončena! Fronta je plná. Spusť daemona.');
  process.exit(0);
}

run();
