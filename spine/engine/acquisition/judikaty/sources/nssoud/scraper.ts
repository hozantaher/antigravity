import * as cheerio from 'cheerio';
import { browserHeaders, randomFrom } from '../../../shared/fetch.js';
import type { ScraperDb } from '../../db.js';
import type { FetchFn } from '../../detail-runner.js';
import { runHtmlDetailPhase } from '../../detail-runner.js';
import type { DecisionData, ScraperConfig } from '../../types.js';

const REFERERS = ['https://www.google.com/', 'https://www.google.cz/', 'https://vyhledavac.nssoud.cz/', ''];

/**
 * NSSoud /DokumentOriginal/Text/ returns UTF-16 LE encoded HTML.
 * Node's response.text() assumes UTF-8 and produces garbled/empty content.
 * This fetcher reads the raw bytes and decodes with the correct charset.
 */
const fetchUtf16Page: FetchFn = async (url, referers) => {
  const response = await fetch(url, {
    redirect: 'follow',
    credentials: 'omit',
    headers: {
      ...browserHeaders(),
      Referer: randomFrom(referers),
    },
    signal: AbortSignal.timeout(30_000),
  });

  const contentType = response.headers.get('content-type') ?? '';
  const charsetMatch = contentType.match(/charset=([\w-]+)/i);
  const charset = charsetMatch?.[1]?.toLowerCase() ?? 'utf-8';

  let html: string;
  if (charset.startsWith('utf-16')) {
    const buf = await response.arrayBuffer();
    html = new TextDecoder(charset).decode(buf);
  } else {
    html = await response.text();
  }

  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) || undefined : undefined;
  return { status: response.status, html, retryAfter };
};

export const parseDetailPage = (html: string, url: string): DecisionData => {
  const $ = cheerio.load(html);
  const data: DecisionData = { url, source: 'nssoud', soud: 'Nejvyšší správní soud' };

  // Extract ID from URL
  const idMatch = url.match(/\/Text\/(\d+)/) ?? url.match(/\/rozhodnuti\/(\w+)/);
  if (idMatch) data.external_id = idMatch[1];

  // NSSoud /DokumentOriginal/Text/ pages are flat HTML: only <body> with <br/> tags.
  // All content is plain text — parse from the text directly.
  const bodyText = (
    $('body')
      .html()
      ?.replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '') ?? ''
  ).trim();
  const lines = bodyText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Title format: "7 As    258/2025-   59 - text" → jednací číslo
  const title = $('title').text().trim();
  const titleMatch = title.match(/^(.+?)\s*-\s*text$/i);
  if (titleMatch) {
    data.jednaci_cislo = titleMatch[1].replace(/\s+/g, ' ').trim();
  }

  // First non-empty line is case file reference (e.g. "7 As 258/2025 - 65")
  // Some pages omit the senate number (e.g. "As 211/2025-29") — fall back to title
  if (lines.length > 0) {
    const firstLine = lines[0];
    if (/^\d+\s+\w+/.test(firstLine)) {
      data.spisova_znacka = firstLine;
    } else if (data.jednaci_cislo) {
      // Derive from jednaci_cislo by stripping the page number suffix (e.g. "4 As 211/2025- 27" → "4 As 211/2025")
      data.spisova_znacka = data.jednaci_cislo.replace(/\s*-\s*\d+$/, '').trim();
    }
  }

  // Decision type: line before "JMÉNEM REPUBLIKY", or standalone keyword in first ~10 lines
  // Some pages use spaced letters like "R O Z S U D E K" — collapse spaces first
  const DECISION_TYPES = ['ROZSUDEK', 'USNESENÍ', 'NÁLEZ', 'STANOVISKO'];
  const collapseLine = (l: string) => l.replace(/(?<=\S) (?=\S)/g, '');
  const jmenemIdx = lines.findIndex((l) => collapseLine(l).includes('JMÉNEM'));
  if (jmenemIdx > 0) {
    const collapsed = collapseLine(lines[jmenemIdx - 1]);
    const match = DECISION_TYPES.find((t) => collapsed === t);
    if (match) {
      data.typ_rozhodnuti = match.charAt(0) + match.slice(1).toLowerCase();
    }
  }
  if (!data.typ_rozhodnuti) {
    for (const line of lines.slice(0, 10)) {
      const collapsed = collapseLine(line);
      const match = DECISION_TYPES.find((t) => collapsed === t);
      if (match) {
        data.typ_rozhodnuti = match.charAt(0) + match.slice(1).toLowerCase();
        break;
      }
    }
  }

  // ECLI from text
  const ecliMatch = bodyText.match(/ECLI:CZ:NSS:\d{4}:\S+/);
  if (ecliMatch) data.ecli = ecliMatch[0];

  // Split by "takto:" and "Odůvodnění:" markers
  // Some pages use spaced letters: "t a k t o :" and "O d ů v o d n ě n í :"
  const taktoMatch = bodyText.match(/t\s*a\s*k\s*t\s*o\s*:/i);
  const oduvMatch = bodyText.match(/O\s*d\s*ů\s*v\s*o\s*d\s*n\s*ě\s*n\s*í\s*:?/i);
  const taktoIdx = taktoMatch ? bodyText.indexOf(taktoMatch[0]) : -1;
  const taktoEnd = taktoMatch ? taktoIdx + taktoMatch[0].length : -1;
  const oduvIdx = oduvMatch ? bodyText.indexOf(oduvMatch[0], taktoEnd > 0 ? taktoEnd : 0) : -1;
  const oduvEnd = oduvMatch && oduvIdx >= 0 ? oduvIdx + oduvMatch[0].length : -1;

  if (taktoIdx >= 0 && oduvIdx > taktoIdx) {
    data.vyrok = bodyText.substring(taktoEnd, oduvIdx).trim();
    data.oduvodneni = bodyText.substring(oduvEnd).trim().substring(0, 100000);
  } else if (taktoIdx >= 0) {
    data.vyrok = bodyText.substring(taktoEnd).trim();
  } else if (oduvIdx >= 0) {
    data.oduvodneni = bodyText.substring(oduvEnd).trim().substring(0, 100000);
  } else {
    // No markers — store entire body as reasoning
    data.oduvodneni = bodyText.substring(0, 100000) || undefined;
  }

  // Raw data
  data.raw_json = JSON.stringify({
    title,
    bodyText: bodyText.substring(0, 50000),
  });

  return data;
};

export const runDetail = (db: ScraperDb, config: ScraperConfig, isShuttingDown: () => boolean) =>
  runHtmlDetailPhase(db, config, isShuttingDown, {
    source: 'nssoud',
    label: 'NSSoud',
    referers: REFERERS,
    parsePage: parseDetailPage,
    fetchFn: fetchUtf16Page,
  });
