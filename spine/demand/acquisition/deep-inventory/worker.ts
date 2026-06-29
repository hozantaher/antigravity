import { Worker, Job } from 'bullmq';
import { CRAWLER_QUEUE_NAME, redisConnection } from './queue';
import { DeltaEngine } from './delta-engine';
import { FastCrawler } from './crawler';
import { FastExtractor } from './fast-extractor';

// @vektor-link: parser-compiler
import { CheerioCompiler } from '../../../engine/intelligence/parser-compiler/index';
// @vektor-link: rule-registry
import { RuleRegistry } from '../../../engine/automation/rule-registry/index';
// @vektor-link: arbitrage-miner
import { ArbitrageMiner } from '../../../engine/intelligence/arbitrage-miner/index';

export class CrawlerWorker {
  private worker: Worker;

  constructor() {
    this.worker = new Worker(CRAWLER_QUEUE_NAME, this.processJob.bind(this), {
      connection: redisConnection as any,
      concurrency: 10, // Zvládneme 10 stránek naráz díky ušetřené RAM z Playwrightu
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
    const domain = new URL(url).hostname;
    console.log(`[CrawlerWorker] Zahajuji těžbu z: ${url}`);

    // 1. Získat HTML bleskurychle
    const html = await FastCrawler.fetchHtml(url);
    if (!html) return;

    // 2. Kouknout do Registru pravidel
    let ruleCode = await RuleRegistry.getRule(domain);
    let items: any[] = [];

    if (ruleCode) {
      console.log(`[CrawlerWorker] ⚡ Používám cachované AST pravidlo pro ${domain}`);
      items = FastExtractor.extract(html, ruleCode, url);
    }

    // 3. Fallback: Kompilátor (Pokud nemáme pravidlo nebo vrátí 0 kvůli změně webu)
    if (!ruleCode || items.length === 0) {
      console.log(`[CrawlerWorker] 🧠 AST pravidlo selhalo nebo chybí. Volám LLM Kompilátor...`);
      ruleCode = await CheerioCompiler.compile(html, url);
      if (ruleCode) {
        await RuleRegistry.saveRule(domain, ruleCode);
        items = FastExtractor.extract(html, ruleCode, url);
      }
    }

    if (items.length === 0) {
      console.log(`[CrawlerWorker] Konec. Na stránce ${url} se nenachází data ani po re-kompilaci.`);
      return;
    }

    console.log(`[CrawlerWorker] Zpracovávám celkem ${items.length} inzerátů z ${url}.`);

    // 4. Předání dat k nacenění a uložení tržního průměru
    for (const item of items) {
      const isNewOrDiscounted = await DeltaEngine.evaluateOpportunity(item.id, item.price);
      if (isNewOrDiscounted) {
        console.log(`[CrawlerWorker] Analyzuji vůči trhu: ${item.title}`);
        await ArbitrageMiner.evaluateAndRecord(item);
      }
    }
  }
}

export const startCrawlerWorker = () => new CrawlerWorker();
