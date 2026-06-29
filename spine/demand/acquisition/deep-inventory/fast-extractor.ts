import * as cheerio from 'cheerio';
// @vektor-link: core-types
import { RawListingSchema, RawListing } from '../../../domain/core-types/index';

export class FastExtractor {
  static extract(html: string, ruleCode: string, sourceUrl: string): RawListing[] {
    const $ = cheerio.load(html);
    try {
       const extractFn = new Function('$', `return ${ruleCode}`);
       const rawItems = extractFn($) || [];
       
       const verifiedItems: RawListing[] = [];
       for (const item of rawItems) {
         if (!item.sourceUrl || item.sourceUrl.startsWith('/')) {
            try {
              const base = new URL(sourceUrl);
              item.sourceUrl = new URL(item.sourceUrl || '', base.origin).toString();
            } catch (e) {}
         }
         if (!item.id && item.title) {
           item.id = 'hash_' + Math.random().toString(36).substring(2, 10);
         }
         
         const result = RawListingSchema.safeParse(item);
         if (result.success) verifiedItems.push(result.data);
       }
       return verifiedItems;
    } catch (e) {
      console.error('[FastExtractor] Extrakce přes evaluovaný script selhala.', e);
      return [];
    }
  }
}
