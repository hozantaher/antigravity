import { RawListing } from '../../../domain/core-types/index';
import { DeepResearchStrategy, HybridRegexLLMStrategy, ResearchResult } from './strategies';

/**
 * Deep Research Miner
 * Analyzes car listings for semantic desperation and hidden risks.
 * 
 * Chosen Strategy: Hybrid Regex -> LLM
 * Důvod výběru: Antigravity vyžaduje asymetrický scale. Spouštět drahý LLM Chain-of-Thought
 * na 100 000 inzerátů denně by zničilo profit margin. Hybridní přístup provede prvotní
 * filtraci přes Regex heurisitku (CPU-bound, zdarma) a až v případě podezření na "zlatou žílu"
 * (zoufalství) nebo "past" (vada), přizve k evaluaci LLM (API call), aby potvrdil kontext.
 */
export class DeepResearchMiner {
  private strategy: DeepResearchStrategy;

  constructor() {
    this.strategy = new HybridRegexLLMStrategy();
  }

  /**
   * Vyhodnotí inzerát a vrátí obohacená sémantická data.
   */
  async analyzeListing(listing: RawListing): Promise<ResearchResult> {
    console.log(`[DeepResearch] Zahajuji sémantickou analýzu: ${listing.title}`);
    const result = await this.strategy.analyze(listing);
    
    if (result.isArbitrage) {
      console.log(`[DeepResearch] 🟢 Potvrzena sémantická arbitráž! Zoufalství: ${result.desperationScore}%`);
    } else if (result.riskScore > 50) {
      console.log(`[DeepResearch] 🔴 Odhalena past! Riziko: ${result.riskScore}% (${result.hiddenFlaws.join(', ')})`);
    }
    
    return result;
  }
}

// Singleton instance
export const deepResearchMiner = new DeepResearchMiner();
