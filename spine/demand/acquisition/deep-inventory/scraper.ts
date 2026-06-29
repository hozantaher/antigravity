import axios from 'axios';
import * as cheerio from 'cheerio';
// @vektor-link: core-types
import { RawListing } from '../../../domain/core-types/index';

export class DeepInventoryScraper {
  /**
   * Vytěží data ze stránky. Vrátí nalezené inzeráty a surové HTML 
   * (potřebné pro případný Self-Healing, pokud selektory selžou).
   */
  public async scrapeInventory(url: string): Promise<{ items: RawListing[], rawHtml: string }> {
    let rawHtml = '';
    const items: RawListing[] = [];

    try {
      console.log(`[DeepInventoryScraper] Vytěžuji data z: ${url}`);
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 10000,
      });
      
      rawHtml = response.data;
      const $ = cheerio.load(rawHtml);
      
      // Heuristický parser
      $('.listing-item, .card, article, .vehicle-card').each((_, element) => {
        const title = $(element).find('h2, .title, .heading, [data-testid="title"]').text().trim();
        const priceText = $(element).find('.price, .amount, [data-testid="price"]').text().replace(/[^0-9]/g, '');
        const price = priceText ? parseInt(priceText, 10) : 0;
        
        // Příklad ID: zkusíme najít data-id, jinak vygenerujeme
        let id = $(element).attr('data-id') || $(element).attr('id');
        if (!id && title) {
          id = `hash_${Buffer.from(title).toString('base64').substring(0, 8)}`;
        }

        if (title && price > 0 && id) {
          items.push({
            id,
            title,
            price,
            sourceUrl: url
          });
        }
      });
      
    } catch (error) {
      console.error(`[DeepInventoryScraper] Chyba při stahování ${url}:`, error);
    }

    return { items, rawHtml };
  }
}
