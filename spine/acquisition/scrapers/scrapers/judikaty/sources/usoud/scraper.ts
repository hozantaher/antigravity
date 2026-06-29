import * as cheerio from 'cheerio';
import { browserHeaders } from '../../../../lib/fetch.js';
import { createProgressTracker, createRateLimiter, retry } from '../../../../lib/utils.js';
import type { ScraperDb } from '../../db.js';
import type { DecisionData, ScraperConfig } from '../../types.js';

const SESSION_URL = 'https://nalus.usoud.cz/Search/Search.aspx';

const acquireSessionCookies = async (): Promise<string> => {
  const response = await fetch(SESSION_URL, {
    headers: browserHeaders(),
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  // Consume body to free resources
  await response.text();

  const setCookies = response.headers.getSetCookie();
  return setCookies
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
};

const fetchWithCookies = async (url: string, cookies: string): Promise<{ status: number; html: string }> => {
  const response = await fetch(url, {
    headers: {
      ...browserHeaders(),
      Cookie: cookies,
      Referer: SESSION_URL,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, html: await response.text() };
};

/** Extract the GetText.aspx URL from the card page HTML */
export const extractGetTextUrl = (html: string): string | undefined => {
  const match = html.match(/https?:\/\/nalus\.usoud\.cz[^"'<>\s]*GetText\.aspx\?sz=[^"'<>\s]+/);
  return match?.[0];
};

/** Parse the GetText.aspx page for výrok and odůvodnění */
export const parseTextPage = (html: string, decision: DecisionData): void => {
  const $ = cheerio.load(html);

  // The page has labeled sections rendered by ASP.NET controls.
  // Content is in <td> cells with style="font-size:10pt;" after label cells.
  // The main decision text is in a large <tr> with the full judgment.

  // Look for the large content block (the actual judgment text)
  // It's typically in a TD with id containing "Obsah" or in a large text block
  const contentTd = $('td[style*="font-size:10pt"]')
    .filter((_, el) => $(el).text().trim().length > 500)
    .first();

  if (!contentTd.length) return;

  const fullText = contentTd.text().trim();
  if (!fullText) return;

  // Split by výrok/odůvodnění markers within the text
  // USoud decisions typically have: header... takto: ... VÝROK ... Odůvodnění: ...
  const vyrokMarkers = [/\btakto:\s*/i, /\bvýrok\b/i];
  const oduvMarkers = [/\bodůvodnění[:.\s]/i, /\bodůvodňuje\b/i];

  let vyrokStart = -1;
  for (const re of vyrokMarkers) {
    const match = fullText.match(re);
    if (match && match.index != null) {
      vyrokStart = match.index + match[0].length;
      break;
    }
  }

  let oduvStart = -1;
  for (const re of oduvMarkers) {
    const match = fullText.match(re);
    if (match && match.index != null && match.index > vyrokStart) {
      oduvStart = match.index + match[0].length;
      break;
    }
  }

  if (vyrokStart >= 0 && oduvStart > vyrokStart) {
    decision.vyrok = fullText.substring(vyrokStart, oduvStart).trim().substring(0, 50000);
    decision.oduvodneni = fullText.substring(oduvStart).trim().substring(0, 100000);
  } else if (oduvStart >= 0) {
    decision.oduvodneni = fullText.substring(oduvStart).trim().substring(0, 100000);
  } else if (vyrokStart >= 0) {
    // No odůvodnění marker — everything after výrok
    decision.oduvodneni = fullText.substring(vyrokStart).trim().substring(0, 100000);
  }
};

export const parseDetailPage = (html: string, url: string): DecisionData => {
  const $ = cheerio.load(html);
  const data: DecisionData = { url, source: 'usoud', soud: 'Ústavní soud' };

  // Extract ID from URL
  const idMatch = url.match(/[?&]id=(\d+)/i);
  if (idMatch) data.external_id = idMatch[1];

  // USoud detail pages use adjacent <td> cells in a table:
  //   <td>Label</td><td>Value</td>
  // Labels appear in cells with text like "Spisová značka:", "ECLI:", etc.
  const fieldMap: Record<string, (val: string) => void> = {
    'Spisová značka': (v) => {
      data.spisova_znacka = v;
    },
    ECLI: (v) => {
      data.ecli = v;
    },
    'Číslo jednací': (v) => {
      data.jednaci_cislo = v;
    },
    'Soudce zpravodaj': (v) => {
      data.autor = v;
    },
    'Datum rozhodnutí': (v) => {
      data.datum_vydani = v;
    },
    'Datum zpřístupnění': (v) => {
      data.datum_zverejneni = v;
    },
    'Forma rozhodnutí': (v) => {
      data.typ_rozhodnuti = v;
    },
    'Typ řízení': (v) => {
      data.predmet_rizeni = v;
    },
    'Předmět řízení': (v) => {
      data.predmet_rizeni = v;
    },
    'Oblast práva': (v) => {
      data.oblast_prava = v;
    },
    'Dotčené ústavní zákony a mezinárodní smlouvy': (v) => {
      data.zminena_ustanoveni = JSON.stringify(
        v
          .split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
    },
    'Typ výroku': (v) => {
      data.klicova_slova = JSON.stringify([v]);
    },
  };

  // Scan all <td> cells for label:value pairs
  $('td').each((_, el) => {
    const cellText = $(el).text().trim();
    const nextTd = $(el).next('td');
    if (!nextTd.length) return;

    const value = nextTd.text().trim();
    if (!value || value === '&nbsp;' || value === '\u00a0') return;

    for (const [label, setter] of Object.entries(fieldMap)) {
      if (cellText === label || cellText === `${label}:`) {
        setter(value);
        return;
      }
    }
  });

  // ECLI fallback from page text
  if (!data.ecli) {
    const ecliMatch = $.text().match(/ECLI:CZ:US:\S+/);
    if (ecliMatch) data.ecli = ecliMatch[0];
  }

  // Content sections — look for labeled divs/panels or heading-based sections
  const sectionLabels: Record<string, keyof DecisionData> = {
    'právní věta': 'pravni_veta',
    'právní věty': 'pravni_veta',
    výrok: 'vyrok',
    'výroková část': 'vyrok',
    odůvodnění: 'oduvodneni',
  };

  $('h2, h3, h4, .section-header, .nadpis').each((_, el) => {
    const heading = $(el).text().trim().toLowerCase();
    for (const [key, field] of Object.entries(sectionLabels)) {
      if (heading.includes(key)) {
        const content = $(el).nextUntil('h2, h3, h4, .section-header, .nadpis').text().trim();
        if (content && !data[field]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (data as any)[field] = content;
        }
      }
    }
  });

  // Fallback: look for ASP.NET panel content by ID patterns
  if (!data.pravni_veta) {
    const pvEl = $('[id*="pravniVeta"], [id*="PravniVeta"], .pravni-veta').first();
    if (pvEl.length) data.pravni_veta = pvEl.text().trim() || undefined;
  }
  if (!data.vyrok) {
    const vEl = $('[id*="vyrok"], [id*="Vyrok"]').first();
    if (vEl.length) data.vyrok = vEl.text().trim() || undefined;
  }
  if (!data.oduvodneni) {
    const oEl = $('[id*="oduvodneni"], [id*="Oduvodneni"]').first();
    if (oEl.length) data.oduvodneni = oEl.text().trim() || undefined;
  }

  // Raw data
  data.raw_json = JSON.stringify({
    title: $('title').text().trim(),
    bodyText: $('form, main, .content, #MainContent').first().text().trim().substring(0, 50000),
  });

  return data;
};

export const runDetail = async (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) => {
  console.log('=== USoud Detail Phase ===');
  console.log(`Concurrency: ${config.concurrency}, Delay: ${config.delay}ms, Max retries: ${config.maxRetries}`);

  const counts = db.getUrlCounts('usoud');
  const totalPending = counts.pending + counts.failed;
  const effectiveTotal = config.limit > 0 ? Math.min(config.limit, totalPending) : totalPending;

  console.log(
    `URLs: ${counts.total.toLocaleString()} total, ${totalPending.toLocaleString()} to process${config.limit > 0 ? ` (limited to ${config.limit})` : ''}`,
  );

  if (effectiveTotal === 0) {
    console.log('No URLs to process.');
    return;
  }

  // Acquire session cookie before starting workers
  console.log('Acquiring session cookie from nalus.usoud.cz...');
  const cookies = await acquireSessionCookies();
  if (!cookies) {
    console.log('Warning: No session cookies received. Requests may return search form instead of content.');
  } else {
    console.log('Session cookie acquired.');
  }

  const progress = createProgressTracker(effectiveTotal);
  const rateLimiter = createRateLimiter(config.delay);
  const runId = db.startRun('usoud-detail');
  const BATCH_SIZE = 1000;

  let processedTotal = 0;

  const progressInterval = setInterval(() => {
    console.log(`${progress.report()} | Delay: ${rateLimiter.getDelay()}ms`);
  }, 30_000);

  try {
    while (!isShuttingDown()) {
      const remaining = config.limit > 0 ? config.limit - processedTotal : BATCH_SIZE;
      if (remaining <= 0) break;

      const batch = db.getPendingUrls('usoud', config.maxRetries, Math.min(BATCH_SIZE, remaining));
      if (batch.length === 0) break;

      let batchIndex = 0;

      const worker = async () => {
        while (!isShuttingDown()) {
          const idx = batchIndex++;
          if (idx >= batch.length) break;

          const urlRow = batch[idx];

          await rateLimiter.wait();

          try {
            let hitRateLimit = false;
            await retry(
              async () => {
                if (hitRateLimit) await rateLimiter.wait();

                const { status, html } = await fetchWithCookies(urlRow.url, cookies);

                if (status === 404 || status === 410) {
                  db.markGone(urlRow.url);
                  progress.incrementFailed();
                  return;
                }

                if (status === 429) {
                  rateLimiter.onRateLimited();
                  hitRateLimit = true;
                  throw new Error('Rate limited (429)');
                }

                if (status >= 500) {
                  throw new Error(`Server error (${status})`);
                }

                if (status !== 200) {
                  throw new Error(`Unexpected status ${status}`);
                }

                const decision = parseDetailPage(html, urlRow.url);

                // Fetch the full text page if available
                if (!decision.vyrok && !decision.oduvodneni) {
                  const getTextUrl = extractGetTextUrl(html);
                  if (getTextUrl) {
                    await rateLimiter.wait();
                    try {
                      const textResult = await fetchWithCookies(getTextUrl, cookies);
                      if (textResult.status === 200) {
                        parseTextPage(textResult.html, decision);
                      }
                    } catch {
                      // Non-fatal — keep metadata from the card page
                    }
                  }
                }

                db.saveDecision(decision);
                progress.increment();
                rateLimiter.onSuccess();
              },
              {
                maxRetries: config.maxRetries,
                baseDelay: config.delay,
                onRetry: (attempt, error) => {
                  console.log(`  Retry ${attempt} for ${urlRow.url}: ${error.message}`);
                },
              },
            );
          } catch (error) {
            db.markFailed(urlRow.url, (error as Error).message);
            progress.incrementFailed();
          }
        }
      };

      const workers = Array.from({ length: config.concurrency }, () => worker());
      await Promise.all(workers);

      processedTotal += batch.length;
      console.log(progress.report());
    }
  } finally {
    clearInterval(progressInterval);
    const stats = progress.getStats();
    const status = isShuttingDown() ? 'interrupted' : 'completed';
    db.finishRun(runId, effectiveTotal, stats.scraped, stats.failed, status);
    console.log(
      `\nUSoud detail phase ${status}. Scraped: ${stats.scraped.toLocaleString()}, Failed: ${stats.failed.toLocaleString()}`,
    );
  }
};
