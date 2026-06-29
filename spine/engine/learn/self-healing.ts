import * as cheerio from 'cheerio';
// @vektor-link: core-types
import { RawListingSchema, RawListing } from '../../../domain/core-types/index';

/**
 * @terminology SelfHealingEngine
 * Kognitivní mechanismus schopný samostatně číst rozbité zdrojové HTML cizích inzertních portálů,
 * osekat ho od šumu a využít LLM k rekonstrukci či vytěžení dat (a tím automaticky opravit scraper).
 */
export class SelfHealingEngine {
  private async askLlmToExtractData(cleanHtml: string): Promise<any[]> {
    console.log(`[SelfHealingEngine] Odesílám ${cleanHtml.length} bytů zjednodušeného HTML do LLM k analýze...`);
    
    // Zde by bylo reálné volání OpenAI API přes RelayEngine.
    // Simulujeme úspěšnou záchranu dat:
    return new Promise((resolve) => setTimeout(() => {
      resolve([
        {
          id: 'llm_rec_' + Math.random().toString(36).substr(2, 6),
          title: 'Záchrana z LLM',
          price: 250000,
          sourceUrl: 'https://example.com/recovered'
        }
      ]);
    }, 1000));
  }

  public async healAndExtract(rawHtml: string, sourceUrl: string): Promise<RawListing[]> {
    console.log(`[SelfHealingEngine] Aktivována kognitivní záchrana dat pro: ${sourceUrl}`);

    const $ = cheerio.load(rawHtml);
    $('script, style, link, noscript, svg, img, iframe, meta').remove();
    const cleanHtml = $('body').html()?.trim() || '';

    if (cleanHtml.length < 50) {
      console.error('[SelfHealingEngine] Stránka je po vyčištění prázdná.');
      return [];
    }

    const rawLlmOutput = await this.askLlmToExtractData(cleanHtml);
    const verifiedListings: RawListing[] = [];
    
    for (const item of rawLlmOutput) {
      item.sourceUrl = item.sourceUrl || sourceUrl; // Doplníme z kontextu, pokud LLM zapomene
      const result = RawListingSchema.safeParse(item);
      
      if (result.success) {
        verifiedListings.push(result.data);
      } else {
        console.warn(`[SelfHealingEngine] Zod zahodil halucinaci LLM:`, result.error.issues);
      }
    }

    console.log(`[SelfHealingEngine] Úspěšně zachráněno inzerátů: ${verifiedListings.length}`);
    return verifiedListings;
  }
}
