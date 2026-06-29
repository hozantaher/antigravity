// @vektor-link: sitemap-watcher
import { crawlerQueue } from '../queue';

/**
 * @terminology DynamicSitemapDiscovery
 * Sleduje sitemap.xml soubory cílových platforem pomocí hlaviček ETag a Last-Modified.
 * Pokud dojde k detekci nového URL inzerátu, okamžitě jej zařadí do fronty k extrakci, 
 * čímž šetří proxy kapacity a minimalizuje vizuální scrapování kategorií.
 */
export class SitemapWatcher {
  private lastETags: Map<string, string> = new Map();

  /**
   * Zkontroluje ETag sitemapy přes HEAD request.
   */
  async checkSitemapForUpdates(sitemapUrl: string): Promise<void> {
    console.log(`[SitemapWatcher] Zjišťuji aktualizace na: ${sitemapUrl}`);
    // Simulace HTTP požadavku pro kontrolu hlavičky ETag
    const currentETag = `"mock-etag-${Math.floor(Date.now() / 60000)}"`; 
    
    if (this.lastETags.get(sitemapUrl) === currentETag) {
      console.log(`[SitemapWatcher] Sitemap bez změny. Ignoruji.`);
      return;
    }

    this.lastETags.set(sitemapUrl, currentETag);
    console.log(`[SitemapWatcher] Změna ETag detekována! Paruji nová URL...`);
    
    // Zde by byla logika parsování XML streamu (SAX parser)
    const mockNewUrls = [
      `https://example.com/auto/${Math.floor(Math.random() * 100000)}`,
      `https://example.com/auto/${Math.floor(Math.random() * 100000)}`
    ];

    for (const url of mockNewUrls) {
      console.log(`[SitemapWatcher] Nalezen nový inzerát, posílám do fronty: ${url}`);
      await crawlerQueue.add('scrape-manual', { url });
    }
  }
}
