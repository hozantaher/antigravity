import { z } from 'zod';

export const RawListingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(3, "Název inzerátu musí mít alespoň 3 znaky"),
  price: z.number().nonnegative("Cena nesmí být záporná"),
  sourceUrl: z.string().url("Neplatná URL inzerátu"),
  // Volitelná pole pro extrakci z LLM
  make: z.string().optional(),
  model: z.string().optional(),
  mileage: z.number().optional(),
  year: z.number().optional(),
  description: z.string().optional(),
});

export type RawListing = z.infer<typeof RawListingSchema>;

export const ResearchResultSchema = z.object({
  desperationScore: z.number().min(0).max(100),
  riskScore: z.number().min(0).max(100),
  hiddenFlaws: z.array(z.string()),
  isArbitrage: z.boolean(),
  reasoning: z.string().optional()
});

export type ResearchResult = z.infer<typeof ResearchResultSchema>;

export const EnrichedListingSchema = RawListingSchema.extend({
  research: ResearchResultSchema,
  numericArbitrageScore: z.number().optional()
});

export type EnrichedListing = z.infer<typeof EnrichedListingSchema>;
