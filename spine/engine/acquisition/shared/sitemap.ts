import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

/** Parse a sitemap index XML → list of sitemap URLs */
export const parseSitemapIndex = (xml: string, filter?: (url: string) => boolean): string[] => {
  const parsed = parser.parse(xml);
  const sitemaps = parsed?.sitemapindex?.sitemap;
  if (!sitemaps) return [];

  const list = Array.isArray(sitemaps) ? sitemaps : [sitemaps];
  const urls = list.map((s: { loc?: string }) => s.loc).filter((loc?: string): loc is string => !!loc);
  return filter ? urls.filter(filter) : urls;
};

/** Parse a sitemap XML → list of URLs with optional lastmod */
export const parseSitemapUrls = (xml: string): SitemapUrl[] => {
  const parsed = parser.parse(xml);
  const urls = parsed?.urlset?.url;
  if (!urls) return [];

  const list = Array.isArray(urls) ? urls : [urls];
  return list.map((u: { loc: string; lastmod?: string }) => ({
    loc: u.loc,
    lastmod: u.lastmod,
  }));
};
