import { redisConnection } from './queue';

/**
 * @terminology DeltaEngine
 * Modul, který na úrovni Kognitivní a Fyzické vrstvy zahazuje data, která již byla zpracována,
 * nebo posílá dál inzeráty s dynamicky se měnící cenou (zlevnění). Odlehčuje LLM frontu.
 */
export class DeltaEngine {
  /**
   * Zkontroluje v Redisu, zda jsme už tento inzerát neviděli, nebo zda nedošlo ke snížení ceny.
   * Vrací TRUE, pokud jde o inzerát s novou hodnotou (příležitost), FALSE pokud se má zahodit.
   */
  static async evaluateOpportunity(listingId: string, currentPrice: number): Promise<boolean> {
    const key = `inventory:delta:${listingId}`;
    const previousPrice = await redisConnection.get(key);
    
    // Zcela nový inzerát
    if (!previousPrice) {
      await redisConnection.set(key, currentPrice, 'EX', 60 * 60 * 24 * 30); // Expirace 30 dní
      return true; 
    }
    
    // Zlevnění inzerátu (indikátor motivovaného prodejce)
    const prevPriceInt = parseInt(previousPrice, 10);
    if (currentPrice > 0 && currentPrice < prevPriceInt) {
      await redisConnection.set(key, currentPrice, 'EX', 60 * 60 * 24 * 30);
      return true;
    }
    
    // Známe a nezlevnilo se
    return false; 
  }
}
