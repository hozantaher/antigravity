import { SymphonyQueue } from '../spine/engine/automation/symphony-queue/logic';
import { ArbitrageOpportunity } from '../spine/domain/core-types';

/**
 * Proof of Concept: Přemostění (Bridge) z legacy Mobile.de scraperu do nové Antigravity architektury.
 * Místo ukládání do lokální SQLite databáze vezmeme extrahovaná data a pošleme je 
 * do SymphonyQueue (Right Hemisphere -> Left Hemisphere).
 */
export async function pushMobileDeListingToSymphony(listing: any): Promise<void> {
  console.log(`[Bridge] Převádím Mobile.de inzerát na ArbitrageOpportunity...`);
  
  // Transformace dat z legacy formátu do nového byznysového DTO
  const expectedProfit = (listing.price_evaluation && listing.price_evaluation.includes('Skvělá cena')) 
    ? 50000 
    : 15000; // Mock profit na základě hodnocení ceny mobile.de

  const opportunity: ArbitrageOpportunity = {
    id: `mobile_de_${listing.mobile_id}`,
    assetId: listing.mobile_id,
    expectedProfit,
    metadata: {
      price: listing.price_czk || (listing.price_eur ? listing.price_eur * 25 : 0),
      title: listing.title,
      url: listing.url,
      mileage: listing.mileage_km,
      source: 'mobile-de-legacy-bridge'
    }
  };

  console.log(`[Bridge] Odesílám inzerát ${opportunity.id} do SymphonyQueue...`);
  await SymphonyQueue.enqueue(opportunity);
  console.log(`[Bridge] Úspěšně odesláno! Shadow Broker to nyní může zpracovat.`);
}

// Simulace vytěžení
async function runPoC() {
  const fakeListing = {
    mobile_id: "123456789",
    url: "https://suchen.mobile.de/fahrzeuge/details.html?id=123456789",
    title: "Škoda Superb 2.0 TDI L&K",
    price_eur: 18000,
    price_evaluation: "Skvělá cena",
    mileage_km: 145000
  };

  await pushMobileDeListingToSymphony(fakeListing);
  
  // Clean up
  setTimeout(() => process.exit(0), 1000);
}

if (require.main === module) {
  runPoC();
}
