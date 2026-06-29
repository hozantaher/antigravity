import { z } from 'zod';

/**
 * @terminology ArbitrageOpportunity
 * Reprezentuje nalezenou příležitost na trhu (inzerát), kde 
 * odhadovaná hodnota od LLM je výrazně vyšší než nabízená cena.
 */
export const ArbitrageOpportunitySchema = z.object({
  id: z.string().describe("Interní unikátní ID v systému"),
  assetId: z.string().describe("Původní ID na inzertním portálu"),
  price: z.number().positive().describe("Aktuální cena inzerátu v CZK"),
  estimatedValue: z.number().positive().describe("Odhadovaná tržní hodnota od AI v CZK"),
  expectedProfit: z.number().describe("Očekávaný hrubý zisk v CZK"),
  metadata: z.record(z.string(), z.any()).describe("Doplňující data o inzerátu (url, title, atd.)")
});

export type ArbitrageOpportunity = z.infer<typeof ArbitrageOpportunitySchema>;

/**
 * @terminology Vehicle
 * Normalizovaná reprezentace stroje v našem katalogu.
 */
export const VehicleSchema = z.object({
  vin: z.string().length(17, "VIN musí mít 17 znaků").optional(),
  make: z.string().min(1, "Značka je povinná"),
  model: z.string().min(1, "Model je povinný"),
  year: z.number().int().min(1900).max(new Date().getFullYear() + 1),
  mileage: z.number().nonnegative(),
});

export type Vehicle = z.infer<typeof VehicleSchema>;

/**
 * @terminology Lead
 * Datový payload, který jde ze scrapingu (Deep Inventory) směrem do Arbitrage Mineru.
 */
export const LeadSchema = z.object({
  url: z.string().url(),
  source: z.enum(['mobile-de', 'mascus', 'firmy-cz', 'manual']),
  vehicle: VehicleSchema,
  dealerContact: z.string().email().optional(),
});

export type Lead = z.infer<typeof LeadSchema>;

/**
 * @terminology ShadowDraft
 * Rozpracovaný, neviditelný návrh inzerátu vytvořený naší Levou hemisférou.
 * Prodejce ho uvidí až po kliknutí na Magic Link.
 */
export const ShadowDraftSchema = z.object({
  draftId: z.string().uuid(),
  contactEmail: z.string().email(),
  opportunityId: z.string(),
  createdAt: z.string().datetime(),
  status: z.enum(['pending', 'claimed', 'expired'])
});

export type ShadowDraft = z.infer<typeof ShadowDraftSchema>;
