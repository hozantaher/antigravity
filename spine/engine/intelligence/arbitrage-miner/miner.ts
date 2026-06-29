import IORedis from 'ioredis';
// @vektor-link: core-types
import { RawListing } from '../../../domain/core-types/index';
// @vektor-link: symphony-queue
import { SymphonyQueue } from '../../automation/symphony-queue/index';

const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

const MAX_HISTORY_PER_MODEL = 500; // Držíme max 500 posledních aut pro přesnou statistiku

export class ArbitrageMiner {
  /**
   * Zaznamená inzerát do Redis historie a vyhodnotí arbitráž pomocí "Antigravity Matrix" algoritmu (V10).
   */
  static async evaluateAndRecord(item: RawListing): Promise<void> {
    const make = (item.make || 'UNKNOWN').toUpperCase();
    const model = (item.model || 'UNKNOWN').toUpperCase();
    const statKey = `market-history:${make}:${model}`;
    
    // 1. Získání historického trhu (např. posledních 500 inzerátů z Redisu)
    const historyRaw = await redis.lrange(statKey, 0, -1);
    const market = historyRaw.map(str => JSON.parse(str) as RawListing);
    
    // 2. Aplikace V10_AntigravityMatrix algoritmu
    const isArbitrage = this.evaluateV10(market, item);
    
    if (isArbitrage) {
      console.log(`[ArbitrageMiner] 🏆 NUMERICKÁ ARBITRÁŽ NALEZENA: ${item.title} za ${item.price} CZK`);
      
      // Odeslání do Deep Research vrstvy (Phase 3 integrace)
      const { deepResearchMiner } = await import('../deep-research/index');
      const researchResult = await deepResearchMiner.analyzeListing(item);

      if (researchResult.isArbitrage && researchResult.riskScore < 50) {
        console.log(`[ArbitrageMiner] 🎯 DEEP RESEARCH POTVRDIL ARBITRÁŽ. Odesílám do ShadowBroker.`);
        // Odeslání k exekuci do levé hemisféry (ShadowBroker)
        await SymphonyQueue.enqueue({
          id: `arb_${item.id}`,
          assetId: item.id,
          expectedProfit: Math.round(item.price * 0.15), // Hrubý odhad
          metadata: { 
            title: item.title, 
            price: item.price, 
            url: item.sourceUrl, 
            make, 
            model,
            desperationScore: researchResult.desperationScore,
            hiddenFlaws: researchResult.hiddenFlaws
          }
        });
      } else {
        console.log(`[ArbitrageMiner] 🛑 ZAMÍTNUTO DEEP RESEARCH UZLEM. Příliš vysoké riziko nebo false positive.`);
      }
    } else {
      console.log(`[ArbitrageMiner] 🛑 Auto ${item.title} nezapadá do arbitrážní matice (Běžná cena nebo vrak).`);
    }

    // 3. Uložení tohoto auta do historie pro budoucí srovnání (učení sítě)
    if (item.price > 0 && item.year && item.mileage) {
      await redis.lpush(statKey, JSON.stringify(item));
      await redis.ltrim(statKey, 0, MAX_HISTORY_PER_MODEL - 1); // Zastřihneme na limit
    }
  }

  /**
   * V10_AntigravityMatrix: Vysoce přesná heuristika s ochranou proti vrakům
   */
  private static evaluateV10(market: RawListing[], target: RawListing): boolean {
    if (!target.year || !target.mileage || target.price <= 0) return false;

    // A. Filtrování kohorty: Jen +-1 rok výroby
    const cohort = market.filter(c => c.year && Math.abs(c.year - target.year!) <= 1);
    if (cohort.length < 3) {
      console.log(`[ArbitrageMiner] Učím se trh... (Málo dat pro ${target.year} ročník)`);
      return false;
    }
    
    // B. IQR Filter (Odstranění vraků a nesmyslných inzerátů z referenčního trhu)
    const prices = cohort.map(c => c.price).sort((a, b) => a - b);
    const q1 = prices[Math.floor(prices.length * 0.25)];
    const q3 = prices[Math.floor(prices.length * 0.75)];
    const iqr = q3 - q1;
    
    // Očištěný trh (ignorujeme cokoliv, co je 1.5 IQR pod Q1, což jsou typicky havarovaná auta)
    const cleanMarket = cohort.filter(c => c.price >= q1 - 1.5 * iqr && c.price <= q3 + 1.5 * iqr); 
    
    if (cleanMarket.length < 2) return false;

    // C. Lokální extrapolace podle nájezdu (Nearest Neighbors v očištěném trhu)
    const getDist = (c: RawListing) => Math.abs((c.mileage || 0) - target.mileage!);
    const peers = cleanMarket.sort((a, b) => getDist(a) - getDist(b)).slice(0, 3);
    const peerAvg = peers.reduce((s, c) => s + c.price, 0) / peers.length;

    // D. Evaluace arbitráže
    // Arbitráž je max -12% pod přesným peer průměrem (skutečná sleva)
    // Ale zároveň nesmí padnout do "zóny vraků" (víc než -35% pod trhem je většinou fatální skrytá závada)
    return target.price <= peerAvg * 0.88 && target.price >= peerAvg * 0.65;
  }
}
