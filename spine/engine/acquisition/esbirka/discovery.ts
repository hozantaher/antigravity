import { createProgressTracker, createRateLimiter, retry } from '../shared/utils.js';
import { fetchAllActs, fetchMetadata } from './api.js';
import type { ScraperDb } from './db.js';
import type { Collection, ScraperConfig, UrlInsert } from './types.js';

/** Parse citace like "89/2012 Sb." or "n1/1960 Sb." into {cislo, rok} */
const parseCitace = (citace: string): { cislo: string; rok: number } | null => {
  const match = citace.match(/^([a-z]?\d+)\/(\d{4})\s/);
  if (!match) return null;
  return { cislo: match[1], rok: parseInt(match[2], 10) };
};

/** Extract base ELI (without version date) from SPARQL subject URI */
const extractEli = (uri: string): string | null => {
  // URI: https://opendata.eselpoint.cz/esel-esb/eli/cz/sb/2012/89 or .../sb/1960/n1
  const match = uri.match(/\/eli\/cz\/(sb|sm)\/\d+\/[a-z]?\d+$/);
  if (!match) return null;
  return uri.replace('https://opendata.eselpoint.cz/esel-esb', '');
};

const runCollectionDiscovery = async (
  db: ScraperDb,
  config: ScraperConfig,
  collection: Collection,
  isShuttingDown: () => boolean,
) => {
  console.log(
    `\n--- Discovery: ${collection === 'sb' ? 'Sbírka zákonů' : 'Sbírka mezinárodních smluv'} (${collection}) ---`,
  );

  // Step 1: SPARQL query to enumerate all acts
  console.log('Fetching act list via SPARQL...');
  const sparqlResult = await fetchAllActs(collection);
  const bindings = sparqlResult.results.bindings;
  console.log(`SPARQL returned ${bindings.length.toLocaleString()} acts`);

  if (bindings.length === 0) return;

  // Parse bindings into act references
  const actRefs = bindings
    .map((b) => {
      const eli = extractEli(b.s.value);
      const citace = b.citace.value;
      const parsed = parseCitace(citace);
      if (!eli || !parsed) return null;
      return { eli, citace, ...parsed, sbirka: collection };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  console.log(`Parsed ${actRefs.length.toLocaleString()} valid act references`);

  // Step 2: Fetch metadata for each act to get typZneni + other fields
  const effectiveTotal = config.limit > 0 ? Math.min(config.limit, actRefs.length) : actRefs.length;
  const toProcess = actRefs.slice(0, effectiveTotal);

  console.log(
    `Fetching metadata for ${effectiveTotal.toLocaleString()} acts${config.limit > 0 ? ` (limited from ${actRefs.length.toLocaleString()})` : ''}...`,
  );

  const progress = createProgressTracker(effectiveTotal);
  const rateLimiter = createRateLimiter(config.delay);
  const BATCH_SIZE = 500;
  let insertedCount = 0;
  let skippedCount = 0;

  const progressInterval = setInterval(() => {
    console.log(
      `${progress.report()} | Delay: ${rateLimiter.getDelay()}ms | Inserted: ${insertedCount}, Skipped: ${skippedCount}`,
    );
  }, 30_000);

  try {
    for (let offset = 0; offset < toProcess.length && !isShuttingDown(); offset += BATCH_SIZE) {
      const batch = toProcess.slice(offset, offset + BATCH_SIZE);
      const urlInserts: UrlInsert[] = [];
      let batchIndex = 0;

      const worker = async () => {
        while (!isShuttingDown()) {
          const idx = batchIndex++;
          if (idx >= batch.length) break;

          const act = batch[idx];
          await rateLimiter.wait();

          try {
            await retry(
              async () => {
                const meta = await fetchMetadata(act.eli);

                // Only insert currently valid acts
                if (meta.typZneni !== 'AKTUALNI') {
                  skippedCount++;
                  progress.increment();
                  rateLimiter.onSuccess();
                  return;
                }

                urlInserts.push({
                  eli: act.eli,
                  citace: act.citace,
                  cislo: act.cislo,
                  rok: act.rok,
                  sbirka: act.sbirka,
                  nazev: meta.nazev,
                  typ_aktu: meta.typAktuKod,
                  typ_zneni: meta.typZneni,
                  datum_platnosti: meta.datumUcinnostiOd,
                  datum_zruseni: undefined,
                  dokument_base_id: meta.dokumentBaseId,
                });

                progress.increment();
                rateLimiter.onSuccess();
              },
              {
                maxRetries: config.maxRetries,
                baseDelay: config.delay,
                onRetry: (attempt, error) => {
                  console.log(`  Retry ${attempt} for ${act.eli}: ${error.message}`);
                },
              },
            );
          } catch (error) {
            progress.incrementFailed();
            console.error(`  Failed ${act.eli}: ${(error as Error).message}`);
          }
        }
      };

      const workers = Array.from({ length: config.concurrency }, () => worker());
      await Promise.all(workers);

      // Batch insert after processing
      if (urlInserts.length > 0) {
        db.insertUrlBatch(urlInserts);
        insertedCount += urlInserts.length;
      }

      console.log(progress.report());
    }
  } finally {
    clearInterval(progressInterval);
  }

  console.log(
    `Discovery complete for ${collection}: ${insertedCount.toLocaleString()} current acts inserted, ${skippedCount.toLocaleString()} non-current skipped`,
  );
};

export const runDiscoveryPhase = async (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) => {
  console.log('=== Discovery Phase ===');

  const ALL_COLLECTIONS: Collection[] = ['sb', 'sm'];
  const collections = config.collection === 'all' ? ALL_COLLECTIONS : [config.collection as Collection];

  for (const collection of collections) {
    if (isShuttingDown()) break;
    await runCollectionDiscovery(db, config, collection, isShuttingDown);
  }

  const counts = db.getUrlCounts();
  console.log(
    `\nDiscovery phase complete. Total acts in DB: ${counts.total.toLocaleString()} (${counts.pending.toLocaleString()} pending)`,
  );

  return counts;
};
