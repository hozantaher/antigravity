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
  const advertFilter = (url: string) => url.includes('sitemap-adverts');

  it('extracts sitemap-adverts URLs', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex>
        <sitemap><loc>https://autoline.cz/sitemap-adverts-1.xml</loc></sitemap>
        <sitemap><loc>https://autoline.cz/sitemap-adverts-2.xml</loc></sitemap>
        <sitemap><loc>https://autoline.cz/sitemap-pages.xml</loc></sitemap>
        <sitemap><loc>https://autoline.cz/sitemap-categories.xml</loc></sitemap>
      </sitemapindex>`;

    const result = parseSitemapIndex(xml, advertFilter);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('sitemap-adverts-1');
    expect(result[1]).toContain('sitemap-adverts-2');
  });

  it('returns empty for no sitemaps', () => {
    const xml = `<?xml version="1.0"?><sitemapindex></sitemapindex>`;
    expect(parseSitemapIndex(xml)).toEqual([]);
  });

  it('handles single sitemap entry', () => {
    const xml = `<?xml version="1.0"?>
      <sitemapindex>
        <sitemap><loc>https://autoline.cz/sitemap-adverts-1.xml</loc></sitemap>
      </sitemapindex>`;
    expect(parseSitemapIndex(xml, advertFilter)).toHaveLength(1);
  });

  it('filters out non-adverts sitemaps', () => {
    const xml = `<?xml version="1.0"?>
      <sitemapindex>
        <sitemap><loc>https://autoline.cz/sitemap-pages.xml</loc></sitemap>
      </sitemapindex>`;
    expect(parseSitemapIndex(xml, advertFilter)).toHaveLength(0);
  });
});

describe('parseSitemapUrls', () => {
  it('parses urlset with multiple URLs', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset>
        <url>
          <loc>https://autoline.cz/truck--123</loc>
          <lastmod>2024-01-01</lastmod>
        </url>
        <url>
          <loc>https://autoline.cz/truck--456</loc>
          <lastmod>2024-01-02</lastmod>
        </url>
      </urlset>`;

    const result = parseSitemapUrls(xml);
    expect(result).toHaveLength(2);
    expect(result[0].loc).toBe('https://autoline.cz/truck--123');
    expect(result[0].lastmod).toBe('2024-01-01');
    expect(result[1].loc).toBe('https://autoline.cz/truck--456');
  });

  it('handles URL without lastmod', () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://autoline.cz/truck--789</loc></url>
      </urlset>`;

    const result = parseSitemapUrls(xml);
    expect(result).toHaveLength(1);
    expect(result[0].loc).toBe('https://autoline.cz/truck--789');
    expect(result[0].lastmod).toBeUndefined();
  });

  it('returns empty for empty urlset', () => {
    const xml = `<?xml version="1.0"?><urlset></urlset>`;
    expect(parseSitemapUrls(xml)).toEqual([]);
  });

  it('handles single URL entry', () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://autoline.cz/one--1</loc></url>
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
      <sitemap><loc>https://autoline.cz/sitemap-adverts-1.xml</loc></sitemap>
    </sitemapindex>`;

  const sitemapUrlsXml = `<?xml version="1.0"?>
    <urlset>
      <url><loc>https://autoline.cz/truck--1</loc><lastmod>2024-01-01</lastmod></url>
      <url><loc>https://autoline.cz/truck--2</loc></url>
    </urlset>`;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fs mocks to default behavior
    existsSync.mockReturnValue(false);
  });

  it('fetches sitemaps and inserts URLs into db', async () => {
    fetchPage
      .mockResolvedValueOnce({ status: 200, html: sitemapIndexXml })
      .mockResolvedValueOnce({ status: 200, html: sitemapUrlsXml });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 }),
    };

    const result = await runSitemapPhase(db as any, () => false);
    expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(2);
  });

  it('processes multiple fetched sitemap files and continues to next file', async () => {
    const multiIndexXml = `<?xml version="1.0"?>
      <sitemapindex>
        <sitemap><loc>https://autoline.cz/sitemap-adverts-1.xml</loc></sitemap>
        <sitemap><loc>https://autoline.cz/sitemap-adverts-2.xml</loc></sitemap>
      </sitemapindex>`;
    const sitemapUrlsXml2 = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://autoline.cz/truck--3</loc></url>
      </urlset>`;

    fetchPage
      .mockResolvedValueOnce({ status: 200, html: multiIndexXml })
      .mockResolvedValueOnce({ status: 200, html: sitemapUrlsXml })
      .mockResolvedValueOnce({ status: 200, html: sitemapUrlsXml2 });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 3, pending: 3, scraped: 0, failed: 0, gone: 0 }),
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
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 }),
    };

    await runSitemapPhase(db as any, () => false);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(db.insertUrlBatch).toHaveBeenCalled();
  });

  it('stops on shutdown', async () => {
    // Index fetch will happen first, then shutdown check in the loop
    fetchPage.mockResolvedValue({ status: 200, html: sitemapIndexXml });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 }),
    };

    await runSitemapPhase(db as any, () => true);
    // Individual sitemaps should not be processed
    expect(db.insertUrlBatch).not.toHaveBeenCalled();
  });

  it('throws on non-200 status for index fetch', async () => {
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

  it('handles fetch errors for individual sitemaps gracefully', async () => {
    fetchPage
      .mockResolvedValueOnce({ status: 200, html: sitemapIndexXml })
      .mockRejectedValueOnce(new Error('Network error'));

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 0, pending: 0, scraped: 0, failed: 0, gone: 0 }),
    };

    // Should not throw — errors are caught per-sitemap
    await runSitemapPhase(db as any, () => false);
    expect(db.insertUrlBatch).not.toHaveBeenCalled();
  });

  it('falls back to full sitemap URL when split/pop filename extraction is unavailable', async () => {
    fetchPage
      .mockResolvedValueOnce({ status: 200, html: sitemapIndexXml })
      .mockResolvedValueOnce({ status: 200, html: sitemapUrlsXml });

    const db = {
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 }),
    };

    const originalPop = Array.prototype.pop;
    const popSpy = vi.spyOn(Array.prototype, 'pop').mockImplementation(function (this: string[]) {
      if (this[0] === 'https:' && this[2] === 'autoline.cz' && this[3]?.includes('sitemap-adverts')) {
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
      'https://autoline.cz/sitemap-adverts-1.xml',
    );
  });
});
