import { SymphonyQueue, ArbitrageOpportunity } from '../../automation/symphony-queue/index';
// @vektor-link: symphony-queue
import { PrivacyGateway } from '../../../platform/security/privacy-gateway/index';
// @vektor-link: privacy-gateway
import { GaraaageAdapter } from './garaaage-adapter';

/**
 * Levá hemisféra: Shadow Broker
 * Naslouchá na frontě a provádí exekutivu (vytváření Shadow Draftů v Garaaage).
 */
export class ShadowBroker {
  private gateway = new PrivacyGateway();
  private garaaage = new GaraaageAdapter();

  constructor() {
    this.initialize();
  }

  private initialize() {
    console.log('[ShadowBroker] Probouzím se, napojuji na SymphonyQueue...');
    
    SymphonyQueue.subscribe(async (op: ArbitrageOpportunity) => {
      await this.executeShadowDraft(op);
    });
  }

  private async executeShadowDraft(op: ArbitrageOpportunity) {
    console.log(`[ShadowBroker] Exekuce pro inzerát ${op.assetId}...`);
    
    // 1. Získání Shadow systémového uživatele
    const shadowUserId = await this.garaaage.ensureShadowSystemUser();
    const draftId = `draft_${op.assetId.substring(0, 8)}`;
    
    console.log(`[ShadowBroker] Ukládám stínový draft [${draftId}] do Garaaage DB...`);
    
    // 2. Vložení tajného inzerátu (hidden: true) přímo do produkční databáze Garaaage
    const price = typeof op.metadata?.price === 'number' ? op.metadata.price : 0;
    
    await this.garaaage.createShadowDraft({
      id: draftId,
      userId: shadowUserId,
      title: op.metadata?.title || 'Arbitrage Vehicle',
      priceAmount: price + op.expectedProfit,
      currency: 'CZK',
      images: op.metadata?.images || [],
      description: op.metadata?.description || {},
    });
    
    // 3. Vygenerování magického linku pro bezpečný přístup k inzerátu (Privacy Gateway)
    const contactMock = `seller_${op.assetId}@example.com`;
    const magicLink = this.gateway.generateMagicLink(draftId, contactMock);
    
    // 4. Odeslání notifikace dealerovi
    console.log(`   -> "Našli jsme kupce pro vaše auto. Klikněte a rovnou zveřejněte aukci za ${price + op.expectedProfit} CZK:"`);
    console.log(`   -> ${magicLink}`);
    
    return Promise.resolve();
  }
}
