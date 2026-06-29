import { parseSitemapIndex, parseSitemapUrls, extractIdFromUrl, runDiscovery } from './discovery.js';

vi.mock('../../../shared/fetch.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchPage: vi.fn() };
});

describe('nsoud discovery', () => {
  describe('parseSitemapIndex', () => {
    it('parses sitemap index XML', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://sbirka.nsoud.cz/sitemap-1.xml</loc></sitemap>
        <sitemap><loc>https://sbirka.nsoud.cz/sitemap-2.xml</loc></sitemap>
      </sitemapindex>`;

      const result = parseSitemapIndex(xml);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('https://sbirka.nsoud.cz/sitemap-1.xml');
    });

    it('returns empty array for non-index XML', () => {
      const xml = `<?xml version="1.0"?><urlset><url><loc>test</loc></url></urlset>`;
      expect(parseSitemapIndex(xml)).toHaveLength(0);
    });

    it('handles single sitemap entry', () => {
      const xml = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://sbirka.nsoud.cz/sitemap-1.xml</loc></sitemap>
      </sitemapindex>`;

      expect(parseSitemapIndex(xml)).toHaveLength(1);
    });
  });

  describe('parseSitemapUrls', () => {
    it('parses decision URLs from sitemap', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://sbirka.nsoud.cz/sbirka/12345/</loc></url>
        <url><loc>https://sbirka.nsoud.cz/sbirka/67890/</loc></url>
        <url><loc>https://sbirka.nsoud.cz/about/</loc></url>
      </urlset>`;

      const result = parseSitemapUrls(xml);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('https://sbirka.nsoud.cz/sbirka/12345/');
    });

    it('filters out non-decision URLs', () => {
      const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://sbirka.nsoud.cz/</loc></url>
        <url><loc>https://sbirka.nsoud.cz/contact/</loc></url>
      </urlset>`;

      expect(parseSitemapUrls(xml)).toHaveLength(0);
    });

    it('returns empty array for empty urlset', () => {
      const xml = `<?xml version="1.0"?><urlset></urlset>`;
      expect(parseSitemapUrls(xml)).toHaveLength(0);
    });
  });

  describe('extractIdFromUrl', () => {
    it('extracts numeric ID', () => {
      expect(extractIdFromUrl('https://sbirka.nsoud.cz/sbirka/12345/')).toBe('12345');
    });

    it('returns undefined for non-matching URL', () => {
      expect(extractIdFromUrl('https://sbirka.nsoud.cz/about/')).toBeUndefined();
    });
  });

  describe('runDiscovery', () => {
    let fetchPage: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      const mod = await import('../../../shared/fetch.js');
      fetchPage = mod.fetchPage as ReturnType<typeof vi.fn>;
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    const mockDb = () => ({
      insertUrlBatch: vi.fn(),
      getUrlCounts: vi.fn().mockReturnValue({ total: 2, pending: 2, scraped: 0, failed: 0, gone: 0 }),
    });

    it('discovers URLs from sitemap', async () => {
      const db = mockDb();
      const sitemapXml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://sbirka.nsoud.cz/sbirka/100/</loc></url>
        <url><loc>https://sbirka.nsoud.cz/sbirka/200/</loc></url>
      </urlset>`;

      fetchPage.mockResolvedValue({ status: 200, html: sitemapXml });

      await runDiscovery(
        db as any,
        { source: 'nsoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 0, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
      const inserted = db.insertUrlBatch.mock.calls[0][0];
      expect(inserted).toHaveLength(2);
      expect(inserted[0].source).toBe('nsoud');
      expect(inserted[0].external_id).toBe('100');
    });

    it('handles sitemap index with child sitemaps', async () => {
      const db = mockDb();
      const indexXml = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://sbirka.nsoud.cz/sitemap-1.xml</loc></sitemap>
      </sitemapindex>`;
      const childXml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://sbirka.nsoud.cz/sbirka/300/</loc></url>
      </urlset>`;

      fetchPage
        .mockResolvedValueOnce({ status: 200, html: indexXml })
        .mockResolvedValueOnce({ status: 200, html: childXml });

      await runDiscovery(
        db as any,
        { source: 'nsoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 0, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalled();
    });

    it('continues when a child sitemap fetch returns non-200', async () => {
      const db = mockDb();
      const indexXml = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://sbirka.nsoud.cz/sitemap-1.xml</loc></sitemap>
      </sitemapindex>`;

      fetchPage
        .mockResolvedValueOnce({ status: 200, html: indexXml })
        .mockResolvedValueOnce({ status: 503, html: '' });

      await runDiscovery(
        db as any,
        { source: 'nsoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 0, dbPath: '' },
        () => false,
      );

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(db.insertUrlBatch).not.toHaveBeenCalled();
    });

    it('respects limit when iterating child sitemaps and stops before fetching more children', async () => {
      const db = mockDb();
      const indexXml = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://sbirka.nsoud.cz/sitemap-1.xml</loc></sitemap>
        <sitemap><loc>https://sbirka.nsoud.cz/sitemap-2.xml</loc></sitemap>
      </sitemapindex>`;
      const childXml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://sbirka.nsoud.cz/sbirka/901/</loc></url>
        <url><loc>https://sbirka.nsoud.cz/sbirka/902/</loc></url>
      </urlset>`;

      fetchPage
        .mockResolvedValueOnce({ status: 200, html: indexXml })
        .mockResolvedValueOnce({ status: 200, html: childXml });

      await runDiscovery(
        db as any,
        { source: 'nsoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
      expect(db.insertUrlBatch.mock.calls[0][0]).toHaveLength(1);
      expect(db.insertUrlBatch.mock.calls[0][0][0].external_id).toBe('901');
    });

    it('throws on fetch failure', async () => {
      const db = mockDb();
      fetchPage.mockResolvedValue({ status: 500, html: '' });

      await expect(
        runDiscovery(
          db as any,
          { source: 'nsoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 0, dbPath: '' },
          () => false,
        ),
      ).rejects.toThrow('Failed to fetch sitemap');
    });

    it('stops on shutdown', async () => {
      const db = mockDb();
      const indexXml = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://sbirka.nsoud.cz/sitemap-1.xml</loc></sitemap>
        <sitemap><loc>https://sbirka.nsoud.cz/sitemap-2.xml</loc></sitemap>
      </sitemapindex>`;

      fetchPage.mockResolvedValue({ status: 200, html: indexXml });

      await runDiscovery(
        db as any,
        { source: 'nsoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 0, dbPath: '' },
        () => true,
      );

      // Should not fetch child sitemaps
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('applies limit for direct urlset sitemap responses', async () => {
      const db = mockDb();
      const sitemapXml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://sbirka.nsoud.cz/sbirka/700/</loc></url>
        <url><loc>https://sbirka.nsoud.cz/sbirka/701/</loc></url>
      </urlset>`;

      fetchPage.mockResolvedValue({ status: 200, html: sitemapXml });

      await runDiscovery(
        db as any,
        { source: 'nsoud', phase: 'discovery', concurrency: 1, delay: 0, maxRetries: 3, limit: 1, dbPath: '' },
        () => false,
      );

      expect(db.insertUrlBatch).toHaveBeenCalledTimes(1);
      expect(db.insertUrlBatch.mock.calls[0][0]).toHaveLength(1);
      expect(db.insertUrlBatch.mock.calls[0][0][0].url).toBe('https://sbirka.nsoud.cz/sbirka/700/');
    });
  });
});
