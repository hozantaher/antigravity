import { parseSitemapIndex, parseSitemapUrls } from '../../lib/sitemap.js';
import { runSitemapPhase } from './sitemap.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ mtimeMs: 0 }),
}));

vi.mock('../../lib/fetch.js', () => ({
  fetchPage: vi.fn(),
  randomFrom: vi.fn((arr: unknown[]) => arr[0]),
}));

describe('parseSitemapIndex', () => {
  const adsFilter = (url: string) => url.includes('_local_ads');

  it('extracts _local_ads URLs', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex>
        <sitemap><loc>https://www.mascus.cz/sitemap_local_ads_1.xml</loc></sitemap>
        <sitemap><loc>https://www.mascus.cz/sitemap_local_ads_2.xml</loc></sitemap>
        <sitemap><loc>https://www.mascus.cz/sitemap_categories.xml</loc></sitemap>
        <sitemap><loc>https://www.mascus.cz/sitemap_pages.xml</loc></sitemap>
      </sitemapindex>`;

    const result = parseSitemapIndex(xml, adsFilter);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('_local_ads');
    expect(result[1]).toContain('_local_ads');
  });

  it('returns empty for no sitemaps', () => {
    const xml = `<?xml version="1.0"?><sitemapindex></sitemapindex>`;
    expect(parseSitemapIndex(xml)).toEqual([]);
  });

  it('handles single sitemap entry', () => {
    const xml = `<?xml version="1.0"?>
      <sitemapindex>
        <sitemap><loc>https://www.mascus.cz/sitemap_local_ads_1.xml</loc></sitemap>
      </sitemapindex>`;
    expect(parseSitemapIndex(xml, adsFilter)).toHaveLength(1);
  });

  it('filters out non-local_ads sitemaps', () => {
    const xml = `<?xml version="1.0"?>
      <sitemapindex>
        <sitemap><loc>https://www.mascus.cz/sitemap_pages.xml</loc></sitemap>
      </sitemapindex>`;
    expect(parseSitemapIndex(xml, adsFilter)).toHaveLength(0);
  });
});

describe('parseSitemapUrls', () => {
  it('parses urlset with multiple URLs', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset>
        <url>
          <loc>https://www.mascus.cz/cat/machine-1.html</loc>
          <lastmod>2024-01-01</lastmod>
        </url>
        <url>
          <loc>https://www.mascus.cz/cat/machine-2.html</loc>
          <lastmod>2024-01-02</lastmod>
        </url>
      </urlset>`;

    const result = parseSitemapUrls(xml);
    expect(result).toHaveLength(2);
    expect(result[0].loc).toBe('https://www.mascus.cz/cat/machine-1.html');
    expect(result[0].lastmod).toBe('2024-01-01');
  });

  it('handles URL without lastmod', () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://www.mascus.cz/cat/machine.html</loc></url>
      </urlset>`;

    const result = parseSitemapUrls(xml);
    expect(result).toHaveLength(1);
    expect(result[0].lastmod).toBeUndefined();
  });

  it('returns empty for empty urlset', () => {
    const xml = `<?xml version="1.0"?><urlset></urlset>`;
    expect(parseSitemapUrls(xml)).toEqual([]);
  });

  it('handles single URL entry', () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://www.mascus.cz/one.html</loc></url>
      </urlset>`;
    const result = parseSitemapUrls(xml);
    expect(result).toHaveLength(1);
  });
});

describe('runSitemapPhase', () => {
  let fetchPage: ReturnType<typeof vi.fn>;
  let existsSync: ReturnType<typeof vi.fn>;
  let readFileSync: ReturnType<typeof vi.fn>;
  let statSync: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const fetchMod = await import('../../lib/fetch.js');
    fetchPage = fetchMod.fetchPage as ReturnType<typeof vi.fn>;
    const fsMod = await import('node:fs');
    existsSync = fsMod.existsSync as ReturnType<typeof vi.fn>;
    readFileSync = fsMod.readFileSync as ReturnType<typeof vi.fn>;
    statSync = fsMod.statSync as ReturnType<typeof vi.fn>;
  });

  const sitemapIndexXml = `<?xml version="1.0"?>
    <sitemapindex>
      <sitemap><loc>https://www.mascus.cz/sitemap_local_ads_1.xml</loc></sitemap>
    </sitemapindex>`;

  const sitemapUrlsXml = `<?xml version="1.0"?>
    <urlset>
      <url><loc>https://www.mascus.cz/cat/m1.html</loc><lastmod>2024-01-01</lastmod></url>
    </urlset>`;

  beforeEach(() => {
    vi.clearAllMocks();
    existsSync.mockReturnValue(false);
  });

  it('fetches sitemaps and inserts URLs into db', async () => {
    fetchPage
      .mockResolvedValueOnce({ status: 200, html: sitemapIndexXml })
      .mockResolvedValueOnce({ status: 200, html: sitemapUrlsXml });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, scraped: 0, failed: 0, gone: 0 }),
    };

    const result = await runSitemapPhase(db as any, () => false);
    expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(1);
  });

  it('processes multiple fetched sitemap files and keeps inserting batches', async () => {
    const multiIndexXml = `<?xml version="1.0"?>
      <sitemapindex>
        <sitemap><loc>https://www.mascus.cz/sitemap_local_ads_1.xml</loc></sitemap>
        <sitemap><loc>https://www.mascus.cz/sitemap_local_ads_2.xml</loc></sitemap>
      </sitemapindex>`;
    const sitemapUrlsXml2 = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://www.mascus.cz/cat/m2.html</loc></url>
      </urlset>`;

    fetchPage
      .mockResolvedValueOnce({ status: 200, html: multiIndexXml })
      .mockResolvedValueOnce({ status: 200, html: sitemapUrlsXml })
      .mockResolvedValueOnce({ status: 200, html: sitemapUrlsXml2 });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 }),
    };

    await runSitemapPhase(db as any, () => false);

    expect(db.insertUrlBatch).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('uses cache when available', async () => {
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ mtimeMs: Date.now() });
    readFileSync.mockReturnValueOnce(sitemapIndexXml).mockReturnValueOnce(sitemapUrlsXml);

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, scraped: 0, failed: 0, gone: 0 }),
    };

    await runSitemapPhase(db as any, () => false);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('handles non-200 status for index fetch', async () => {
    fetchPage.mockResolvedValue({ status: 500, html: '' });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 }),
    };

    await expect(runSitemapPhase(db as any, () => false)).rejects.toThrow('HTTP 500');
  });

  it('handles non-200 status for individual sitemap fetch', async () => {
    fetchPage
      .mockResolvedValueOnce({ status: 200, html: sitemapIndexXml })
      .mockResolvedValueOnce({ status: 500, html: '' });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 }),
    };

    // Individual sitemap error is caught, doesn't throw
    await runSitemapPhase(db as any, () => false);
    expect(db.insertUrlBatch).not.toHaveBeenCalled();
  });

  it('stops on shutdown', async () => {
    fetchPage.mockResolvedValue({ status: 200, html: sitemapIndexXml });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 }),
    };

    await runSitemapPhase(db as any, () => true);
    expect(db.insertUrlBatch).not.toHaveBeenCalled();
  });

  it('falls back to full sitemap URL when split/pop filename extraction is unavailable', async () => {
    fetchPage
      .mockResolvedValueOnce({ status: 200, html: sitemapIndexXml })
      .mockResolvedValueOnce({ status: 200, html: sitemapUrlsXml });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 1, pending: 1, scraped: 0, failed: 0, gone: 0 }),
    };

    const originalPop = Array.prototype.pop;
    const popSpy = vi.spyOn(Array.prototype, 'pop').mockImplementation(function (this: string[]) {
      if (this[0] === 'https:' && this[2] === 'www.mascus.cz' && this[3]?.includes('sitemap_local_ads')) {
        return undefined;
      }
      return originalPop.apply(this);
    });

    try {
      await runSitemapPhase(db as any, () => false);
    } finally {
      popSpy.mockRestore();
    }

    expect(db.insertUrlBatch).toHaveBeenCalledWith(
      expect.any(Array),
      'https://www.mascus.cz/sitemap_local_ads_1.xml',
    );
  });
});
