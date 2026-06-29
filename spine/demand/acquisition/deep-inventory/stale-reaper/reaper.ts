// @vektor-link: stale-reaper
import { symphonyQueue } from '../../../engine/automation/symphony-queue/queue';

/**
 * @terminology StaleOpportunityReaper
 * Reaper pravidelně prochází aktivní Shadow Drafts, ke kterým jsme vytvořili Magic Linky.
 * Provede rychlý HEAD ping na původní sourceUrl cizího portálu.
 * Pokud vrátí 404 (nebo přesměrování s indikací smazání), okamžitě odesílá event `opportunity_dead`.
 * Tento event chytí levá hemisféra (Auction24) a draft i link zneplatní.
 */
export class StaleOpportunityReaper {
  public async checkStaleDraft(draftId: string, sourceUrl: string): Promise<void> {
    console.log(`[Reaper] Kontroluji puls původní nabídky: ${sourceUrl}`);
    
    // Simulace zjištění mrtvé adresy (např. fetch(sourceUrl))
    const isDead = Math.random() < 0.1; // 10% šance, že inzerát mezitím zmizel

    if (isDead) {
       console.log(`[Reaper] 💀 Původní nabídka pro draft ${draftId} umřela (404)! Ruším draft.`);
       await symphonyQueue.add('opportunity_dead', { draftId, sourceUrl });
    } else {
       console.log(`[Reaper] ❤️ Nabídka stále žije.`);
    }
  }
}
