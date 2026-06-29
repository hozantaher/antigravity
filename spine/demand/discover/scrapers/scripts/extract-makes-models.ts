import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { parseArgs } from 'node:util';
import { createFileCache } from '../lib/cache.js';
import { parseSitemapIndex, parseSitemapUrls } from '../lib/sitemap.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    output: { type: 'string', default: '' },
  },
});

const OUTPUT_PATH = values.output || resolve('output', 'vehicle-makes-models.json');
const cache = createFileCache(resolve('.sitemap-cache-makes'));

const MASCUS_SITEMAP_INDEX = 'https://www.mascus.cz/sitemap_index_cz.xml';
const AUTOLINE_SITEMAP_INDEX = 'https://autoline.cz/sitemap.xml';

interface MakeModel {
  name: string;
  children: { name: string }[];
}

async function fetchWithCache(url: string, cacheKey: string): Promise<string> {
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  cache.set(cacheKey, text);
  return text;
}

/** Capitalize brand/model name: "john_deere" → "John Deere", "CASE IH" stays */
function normalizeName(raw: string): string {
  const name = raw.replace(/[-_]/g, ' ').trim();
  // If already has uppercase letters (e.g. "CASE IH", "CAT"), keep as-is
  if (name !== name.toLowerCase()) return name;
  // Title-case lowercase names
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parse Mascus model-level sitemap URLs: /{category}/{brand},{model},1,relevance,search.html */
function parseMascusModels(urls: string[]): Map<string, Set<string>> {
  const makes = new Map<string, Set<string>>();

  for (const url of urls) {
    // URL format: https://www.mascus.cz/{domain}/{category}/{brand},{model},1,relevance,search.html
    const match = url.match(/\/([^/,]+),([^/,]+),1,relevance,search\.html$/);
    if (!match) continue;

    const brand = canonicalBrand(normalizeName(decodeURIComponent(match[1])));
    const model = normalizeName(decodeURIComponent(match[2]));

    if (!brand || !model || brand.length < 2) continue;

    if (!makes.has(brand)) makes.set(brand, new Set());
    makes.get(brand)!.add(model);
  }

  return makes;
}

/** Parse Autoline sitemap URLs that have BOTH tm#### (brand) AND m#### (model) codes.
 *  Format: /.../Category/Brand/Model--c##tm####m####
 *  URLs without m#### are category/brand-only pages — skip them. */
function parseAutolineModels(urls: string[]): Map<string, Set<string>> {
  const makes = new Map<string, Set<string>>();

  for (const url of urls) {
    // Must have both tm (brand ID) and m (model ID) codes
    if (!url.match(/tm\d+/) || !url.match(/(?<![t])m\d+/)) continue;

    // Extract last two path segments before the code suffix
    // e.g. /pohonne-jednotky/tahace/Mercedes-Benz/Actros--c598fc42tm2675m888
    const path = new URL(url).pathname;
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 3) continue;

    // Last segment has model + codes, second-to-last is brand
    const lastSeg = segments[segments.length - 1];
    const modelMatch = lastSeg.match(/^(.+?)--/);
    if (!modelMatch) continue;

    const brand = decodeURIComponent(segments[segments.length - 2]).trim();
    const model = decodeURIComponent(modelMatch[1]).trim();

    if (!brand || !model || brand.length < 2 || model.length < 2) continue;
    if (/^\d+$/.test(brand) || /^\d+$/.test(model)) continue;

    if (!makes.has(brand)) makes.set(brand, new Set());
    makes.get(brand)!.add(model);
  }

  return makes;
}

/** Canonical brand name for deduplication: "Mercedes Benz" → "Mercedes-Benz" */
const BRAND_ALIASES: Record<string, string> = {
  'Mercedes Benz': 'Mercedes-Benz',
  Jcb: 'JCB',
  Cat: 'CAT',
  Daf: 'DAF',
  Man: 'MAN',
  Bmw: 'BMW',
  'Fiat Hitachi': 'Fiat-Hitachi',
};

function canonicalBrand(name: string): string {
  return BRAND_ALIASES[name] ?? name;
}

/** Merge two make→model maps */
function mergeMakes(target: Map<string, Set<string>>, source: Map<string, Set<string>>): void {
  for (const [brand, models] of source) {
    const canonical = canonicalBrand(brand);
    if (!target.has(canonical)) target.set(canonical, new Set());
    for (const model of models) target.get(canonical)!.add(model);
  }
}

/** Convert map to sorted output format */
function toOutput(makes: Map<string, Set<string>>): MakeModel[] {
  return Array.from(makes.entries())
    .sort(([a], [b]) => a.localeCompare(b, 'cs'))
    .map(([name, models]) => ({
      name,
      children: Array.from(models)
        .sort((a, b) => a.localeCompare(b, 'cs'))
        .map((m) => ({ name: m })),
    }));
}

async function main() {
  const allMakes = new Map<string, Set<string>>();

  // --- Mascus: model-level sitemaps ---
  console.log('Fetching Mascus sitemap index...');
  const mascusIndex = await fetchWithCache(MASCUS_SITEMAP_INDEX, 'mascus-sitemap-index.xml');
  const modelSitemaps = parseSitemapIndex(mascusIndex, (url) => url.includes('_category_brand_model_browse'));
  console.log(`  Found ${modelSitemaps.length} model-level sitemaps`);

  for (const sitemapUrl of modelSitemaps) {
    const fileName = sitemapUrl.split('/').pop() ?? sitemapUrl;
    console.log(`  Parsing ${fileName}...`);
    const xml = await fetchWithCache(sitemapUrl, fileName);
    const urls = parseSitemapUrls(xml).map((u) => u.loc);
    const makes = parseMascusModels(urls);
    mergeMakes(allMakes, makes);
    console.log(`    ${makes.size} brands, ${Array.from(makes.values()).reduce((s, m) => s + m.size, 0)} models`);
  }

  // --- Autoline: advert-list sitemaps ---
  console.log('\nFetching Autoline sitemap index...');
  const autolineIndex = await fetchWithCache(AUTOLINE_SITEMAP_INDEX, 'autoline-sitemap-index.xml');
  const advertSitemaps = parseSitemapIndex(autolineIndex, (url) => url.includes('sitemap-advert-lists'));
  console.log(`  Found ${advertSitemaps.length} advert-list sitemaps`);

  for (const sitemapUrl of advertSitemaps) {
    const fileName = sitemapUrl.split('/').pop() ?? sitemapUrl;
    console.log(`  Parsing ${fileName}...`);
    const xml = await fetchWithCache(sitemapUrl, fileName);
    const urls = parseSitemapUrls(xml).map((u) => u.loc);
    const makes = parseAutolineModels(urls);
    mergeMakes(allMakes, makes);
    console.log(`    ${makes.size} brands, ${Array.from(makes.values()).reduce((s, m) => s + m.size, 0)} models`);
  }

  // --- Output ---
  const output = toOutput(allMakes);
  const totalModels = output.reduce((s, m) => s + m.children.length, 0);

  console.log(`\nTotal: ${output.length} makes, ${totalModels} models`);

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Saved to ${OUTPUT_PATH}`);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
