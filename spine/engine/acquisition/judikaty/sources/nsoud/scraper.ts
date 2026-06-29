import * as cheerio from 'cheerio';
import type { ScraperDb } from '../../db.js';
import type { FetchFn } from '../../detail-runner.js';
import { runHtmlDetailPhase } from '../../detail-runner.js';
import type { DecisionData, ScraperConfig } from '../../types.js';

const REFERERS = [
  'https://www.google.com/',
  'https://www.google.cz/',
  'https://www.seznam.cz/',
  'https://sbirka.nsoud.cz/',
  '',
];

/** Map genitive court name to nominative form */
const normalizeCourtName = (genitive: string): string => {
  const map: Record<string, string> = {
    'nejvyššího soudu': 'Nejvyšší soud',
    'ústavního soudu': 'Ústavní soud',
    'nejvyššího správního soudu': 'Nejvyšší správní soud',
    'vrchního soudu': 'Vrchní soud',
    'krajského soudu': 'Krajský soud',
    'okresního soudu': 'Okresní soud',
    'městského soudu': 'Městský soud',
    'obvodního soudu': 'Obvodní soud',
    'obchodního soudu': 'Krajský obchodní soud',
    'obchodní soud': 'Krajský obchodní soud',
  };
  const lower = genitive.toLowerCase();
  for (const [key, val] of Object.entries(map)) {
    if (lower.includes(key)) return val;
  }
  return genitive;
};

export const parseDetailPage = (html: string, url: string): DecisionData => {
  const $ = cheerio.load(html);
  const data: DecisionData = { url, source: 'nsoud' };

  // Extract ID from URL
  const idMatch = url.match(/\/sbirka\/(\d+)/);
  if (idMatch) data.external_id = idMatch[1];

  // --- Parse <h1> for decision type, court, date, case number ---
  const h1Text = $('h1').first().text().trim();
  if (h1Text) {
    // typ_rozhodnuti: first word (e.g. "Usnesení", "Rozsudek")
    const firstWord = h1Text.match(/^(\S+)/);
    if (firstWord) data.typ_rozhodnuti = firstWord[1];

    // soud: extract court name (genitive "soudu" or nominative "soud") and normalise
    // Also handle "Zvláštní senát" (special senate, not a court)
    if (/zvláštní\s+senát/i.test(h1Text)) {
      data.soud = 'Zvláštní senát';
    } else {
      const courtMatch = h1Text.match(/\b(\S+\s+(?:obchodní\s+)?soudu?(?:\s+\S+)?)\b/i);
      if (courtMatch) data.soud = normalizeCourtName(courtMatch[1]);
    }

    // datum_vydani: date in DD.MM.YYYY
    const dateMatch = h1Text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    if (dateMatch) data.datum_vydani = dateMatch[1];

    // spisova_znacka: text after "sp. zn."
    const spZnMatch = h1Text.match(/sp\.\s*zn\.\s*(.+)$/i);
    if (spZnMatch) data.spisova_znacka = spZnMatch[1].trim();
  }

  // --- Extract oblast_prava from <h2> ---
  $('h2').each((_, el) => {
    const text = $(el).text().trim();
    // Skip structural / navigational headings
    if (!text || /^(výrok|odůvodnění|sbírkový|menu|navigace)/i.test(text)) return;
    if (!data.oblast_prava) data.oblast_prava = text;
  });

  // --- Extract právní věta from og:description meta tag ---
  const ogDesc = $('meta[property="og:description"]').attr('content')?.trim();
  if (ogDesc) data.pravni_veta = ogDesc;

  // --- Extract heslo / předpisy from <strong> labels ---
  $('strong').each((_, el) => {
    const label = $(el).text().trim().replace(/:$/, '');
    if (!label) return;

    // Collect text that follows the <strong> element (sibling text / next elements)
    const parent = $(el).parent();
    const parentHtml = parent.html() ?? '';
    // Get text after this <strong> tag up to the next <strong> or end
    const strongOuterHtml = $.html(el);
    const idx = parentHtml.indexOf(strongOuterHtml);
    if (idx < 0) return;
    const after = parentHtml.substring(idx + strongOuterHtml.length);
    // Strip up to next <strong> or end
    const nextStrongIdx = after.indexOf('<strong');
    const segment = nextStrongIdx >= 0 ? after.substring(0, nextStrongIdx) : after;
    const value = segment.replace(/<[^>]+>/g, '').trim();
    if (!value) return;

    const lower = label.toLowerCase();
    if (lower === 'heslo') {
      data.klicova_slova = value;
    } else if (lower === 'předpisy' || lower === 'předpis') {
      data.zminena_ustanoveni = value;
    }
  });

  // --- Extract verdict (výrok) and reasoning (odůvodnění) from sections ---
  $('h2, h3, .section-title').each((_, el) => {
    const heading = $(el).text().trim().toLowerCase();
    const content = $(el).nextUntil('h2, h3, .section-title').text().trim();
    if (!content) return;

    if (heading.includes('výrok')) {
      data.vyrok = content;
    } else if (heading.includes('odůvodnění')) {
      data.oduvodneni = content;
    }
  });

  // If no structured sections found, try getting main content
  if (!data.vyrok && !data.oduvodneni) {
    const mainContent = $('.entry-content, .rozhodnuti-text, .decision-text, article .content').first();
    if (mainContent.length) {
      const fullText = mainContent.text().trim();
      if (fullText) {
        const vyrokIdx = fullText.search(/výrok/i);
        const oduvIdx = fullText.search(/odůvodnění/i);

        if (vyrokIdx >= 0 && oduvIdx > vyrokIdx) {
          data.vyrok = fullText.substring(vyrokIdx, oduvIdx).trim();
          data.oduvodneni = fullText.substring(oduvIdx).trim();
        } else {
          data.oduvodneni = fullText;
        }
      }
    }
  }

  // Extract "Sbírkový text" link for the text sub-page
  data._textPageUrl = $('a[href*="?p="]')
    .filter((_, el) => ($(el).attr('href') ?? '').includes('sbirka.nsoud.cz'))
    .first()
    .attr('href');

  // Store raw HTML for reprocessing
  data.raw_json = JSON.stringify({
    title: $('title').text().trim(),
    meta: Object.fromEntries(
      $('meta[name], meta[property]')
        .toArray()
        .map((el) => [$(el).attr('name') ?? $(el).attr('property'), $(el).attr('content')]),
    ),
    bodyText: $('article, .entry-content, main, .content').first().text().trim().substring(0, 50000),
  });

  return data;
};

/** Parse the "Sbírkový text rozhodnutí" sub-page for full text content and ECLI */
export const parseTextPage = (html: string, decision: DecisionData): void => {
  const $ = cheerio.load(html);

  // ECLI from <title> — works for all court types (NS, KSCB, KSPH, etc.)
  if (!decision.ecli) {
    const title = $('title').text();
    const ecliMatch = title.match(/ECLI:CZ:[A-Z]+:\S+/);
    if (ecliMatch) decision.ecli = ecliMatch[0].replace(/\s*-\s*$/, '');
  }

  const content = $('.detail-section__content')
    .text()
    .replace(/\u00a0/g, ' ')
    .trim();
  if (!content) return;

  // Split by "Právní věta:" and "Z odůvodnění:" markers
  const pvIdx = content.indexOf('Právní věta');
  const zOduvIdx = content.indexOf('Z odůvodnění');

  if (pvIdx >= 0 && zOduvIdx > pvIdx) {
    const pvText = content
      .substring(pvIdx + 'Právní věta'.length, zOduvIdx)
      .replace(/^[:\s]+/, '')
      .trim();
    if (pvText && !decision.pravni_veta) decision.pravni_veta = pvText;
    const oduvText = content
      .substring(zOduvIdx + 'Z odůvodnění'.length)
      .replace(/^[:\s]+/, '')
      .trim();
    if (oduvText) decision.oduvodneni = oduvText.substring(0, 100000);
  } else if (zOduvIdx >= 0) {
    const oduvText = content
      .substring(zOduvIdx + 'Z odůvodnění'.length)
      .replace(/^[:\s]+/, '')
      .trim();
    if (oduvText) decision.oduvodneni = oduvText.substring(0, 100000);
  } else if (pvIdx >= 0 && !decision.oduvodneni) {
    // No "Z odůvodnění" marker — everything after právní věta is the content
    const afterPv = content
      .substring(pvIdx + 'Právní věta'.length)
      .replace(/^[:\s]+/, '')
      .trim();
    if (afterPv) decision.oduvodneni = afterPv.substring(0, 100000);
  }
};

/** Post-process: fetch the linked "Sbírkový text" page for full decision content */
const fetchTextSubPage = async (decision: DecisionData, fetchFn: FetchFn): Promise<void> => {
  const textUrl = decision._textPageUrl;
  if (!textUrl) return;

  try {
    const { status, html } = await fetchFn(textUrl, REFERERS);
    if (status !== 200) return;

    parseTextPage(html, decision);
  } catch {
    // Non-fatal — keep whatever we already have
  }
};

export const runDetail = (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) =>
  runHtmlDetailPhase(db, config, isShuttingDown, {
    source: 'nsoud',
    label: 'NSoud',
    referers: REFERERS,
    parsePage: parseDetailPage,
    postProcess: fetchTextSubPage,
  });
