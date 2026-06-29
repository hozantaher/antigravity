import { DeepInventoryScraper } from '../spine/demand/acquisition/deep-inventory/scraper';

/**
 * Prove-Me-Wrong (PMW) & PoC Skript
 * Hypotéza: Současný `DeepInventoryScraper` (pravá hemisféra) je postaven na `axios` + `cheerio`.
 * Tvrdím, že toto architektonické rozhodnutí je smrtelné pro "Infinite Supply Machine", 
 * protože moderní portály (např. Sauto.cz, Mobile.de) jsou Single Page Aplikace (React/Vue),
 * kde je HTML při prvním stažení prázdné a obsah se renderuje asynchronně přes JavaScript.
 * 
 * Tento PoC dokazuje, že scraper je na takových webech naprosto slepý.
 */
async function runProveMeWrong() {
  console.log('🔬 [PMW] Spouštím hloubkový test schopností DeepInventoryScraperu na moderním SPA portálu...');
  const scraper = new DeepInventoryScraper();

  // Testovací URL (Sauto je SPA)
  const targetUrl = 'https://www.sauto.cz/inzerce/osobni';

  console.log(`🌐 [PMW] Pokus o vytěžení SPA: ${targetUrl}`);
  const startTime = Date.now();
  
  const { items, rawHtml } = await scraper.scrapeInventory(targetUrl);
  
  const duration = Date.now() - startTime;
  console.log(`⏱️  [PMW] Hotovo za ${duration} ms.`);
  console.log(`📦 [PMW] Vytěženo položek: ${items.length}`);
  
  // Detekce SPA / Prázdného těla
  const hasRootDiv = rawHtml.includes('<div id="root"></div>') || rawHtml.includes('<div id="app"></div>');
  const hasListings = rawHtml.includes('c-item__name') || rawHtml.includes('c-item__price');

  if (items.length === 0 && !hasListings && hasRootDiv) {
    console.log('🚨 [ZÁVĚR PMW]: HYPOTÉZA POTVRZENA!');
    console.log('   -> Scraper vrátil 0 inzerátů, protože stáhl pouze prázdný React/Vue obal <div id="root"></div>.');
    console.log('   -> Současný kód v `deep-inventory/scraper.ts` je defektní pro moderní webové stránky.');
    console.log('   -> NÁPRAVA: Aby vektor fungoval, musíme sem přenést logiku z Playwright (z legacy scrapers).');
  } else {
    console.log('✅ [ZÁVĚR PMW]: Hypotéza vyvrácena, Cheerio nějakým zázrakem našlo inzeráty (SSR).');
  }
}

runProveMeWrong().catch(console.error);
