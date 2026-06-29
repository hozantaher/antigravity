import { Worker, Job } from 'bullmq';
import { CRAWLER_QUEUE_NAME, redisConnection } from './queue';
import { DeltaEngine } from './delta-engine';
import { DeepInventoryScraper } from './scraper';

// @vektor-link: engine-learn
import { SelfHealingEngine } from '../../../engine/learn/index';
// @vektor-link: symphony-queue
import { SymphonyQueue } from '../../../engine/automation/symphony-queue/index';

export class CrawlerWorker {
  private worker: Worker;
  private scraper = new DeepInventoryScraper();
  private healer = new SelfHealingEngine();

  constructor() {
    this.worker = new Worker(CRAWLER_QUEUE_NAME, this.processJob.bind(this), {
      connection: redisConnection as any,
      concurrency: 2, 
    });

    this.worker.on('completed', (job) => {
      console.log(`[CrawlerWorker] Úloha ${job.id} úspěšně dokončena.`);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`[CrawlerWorker] Kritické selhání úlohy ${job?.id}:`, err);
    });
  }

  private async processJob(job: Job) {
    const { url } = job.data;
    console.log(`[CrawlerWorker] Zahajuji těžbu z: ${url}`);

    // KROK 1: Pokus o rychlý extraction přes Cheerio
    let { items, rawHtml } = await this.scraper.scrapeInventory(url);
    
    // KROK 2: Kognitivní záchrana (Self-Healing)
    if (items.length === 0 && rawHtml.length > 0) {
      console.warn(`[CrawlerWorker] Heuristika selhala (0 inzerátů nalezeno). Volám LLM Self-Healing pro ${url}...`);
      items = await this.healer.healAndExtract(rawHtml, url);
    }
    
    if (items.length === 0) {
      console.log(`[CrawlerWorker] Konec. Na stránce ${url} se nenachází žádná validní data ani po zásahu AI.`);
      return;
    }

    console.log(`[CrawlerWorker] Zpracovávám celkem ${items.length} inzerátů z ${url}.`);

    // KROK 3: Odeslání do Symphony
    for (const item of items) {
      const isNewOrDiscounted = await DeltaEngine.evaluateOpportunity(item.id, item.price);
      
      if (isNewOrDiscounted) {
        console.log(`[CrawlerWorker] Nalezen neznámý nebo zlevněný vůz: ${item.title}`);
        
        const estimatedProfit = item.price * 0.15; 
        
        await SymphonyQueue.enqueue({
          id: `arb_${item.id}`,
          assetId: item.id,
          expectedProfit: estimatedProfit,
          metadata: {
            title: item.title,
            price: item.price,
            url: item.sourceUrl
          }
        });
      }
    }
  }
}

export const startCrawlerWorker = () => new CrawlerWorker();
