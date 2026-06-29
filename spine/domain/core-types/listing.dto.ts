import { z } from 'zod';

export const RawListingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(3, "Název inzerátu musí mít alespoň 3 znaky"),
  price: z.number().nonnegative("Cena nesmí být záporná"),
  sourceUrl: z.string().url("Neplatná URL inzerátu"),
  // Volitelná pole pro extrakci z LLM
  mileage: z.number().optional(),
  year: z.number().optional(),
});

export type RawListing = z.infer<typeof RawListingSchema>;
