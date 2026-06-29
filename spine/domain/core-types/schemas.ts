import { z } from 'zod';

/**
 * @terminology ArbitrageOpportunity
 * Reprezentuje nalezenou příležitost na trhu (inzerát), kde 
 * odhadovaná hodnota od LLM je výrazně vyšší než nabízená cena.
 */
export const ArbitrageOpportunitySchema = z.object({
  id: z.string().describe("Interní unikátní ID v systému"),
  assetId: z.string().describe("Původní ID na inzertním portálu"),
  expectedProfit: z.number().positive().describe("Očekávaný hrubý zisk v CZK"),
  metadata: z.record(z.any()).describe("Doplňující data o inzerátu (url, title, atd.)")
});

export type ArbitrageOpportunity = z.infer<typeof ArbitrageOpportunitySchema>;

/**
 * @terminology ShadowDraft
 * Rozpracovaný, neviditelný návrh inzerátu vytvořený naší Levou hemisférou.
 * Prodejce ho uvidí až po kliknutí na Magic Link.
 */
export const ShadowDraftSchema = z.object({
  draftId: z.string(),
  contact: z.string(),
  createdAt: z.string().datetime(),
  status: z.enum(['pending', 'claimed', 'expired'])
});

export type ShadowDraft = z.infer<typeof ShadowDraftSchema>;
