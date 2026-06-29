import { crawlerQueue } from './queue';

export class CrawlerScheduler {
  /**
   * Spustí discovery proces - naplánuje pravidelné indexování sitemap a feedů.
   */
  static async startDiscovery() {
    console.log('[CrawlerScheduler] Nastavuji pravidelné seedování...');

    // Příklad periodického jobu: kontrola novinek každých 15 minut
    await crawlerQueue.add('scrape-news', {
      url: 'https://example-auto.cz/nejnovejsi'
    }, {
      repeat: {
        pattern: '*/15 * * * *' // Cron každých 15 minut
      }
    });

    console.log('[CrawlerScheduler] Discovery Cron nastaven.');
  }

  /**
   * Jednorázový seed pro okamžitou exekuci (např. ruční trigger z CLI).
   */
  static async seedManual(url: string) {
    await crawlerQueue.add('scrape-manual', { url });
    console.log(`[CrawlerScheduler] Manuální seed vložen: ${url}`);
  }
}
