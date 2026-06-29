import { createDb } from './db.js';

describe('autoline db', () => {
  let db: ReturnType<typeof createDb>;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('insertUrlBatch + getPendingUrls', () => {
    it('inserts URLs and retrieves pending', () => {
      db.insertUrlBatch(
        [{ loc: 'https://autoline.cz/a--1', lastmod: '2024-01-01' }, { loc: 'https://autoline.cz/a--2' }],
        'sitemap-1.xml',
      );

      const pending = db.getPendingUrls(3, 10);
      expect(pending).toHaveLength(2);
      expect(pending[0].url).toBe('https://autoline.cz/a--1');
      expect(pending[0].status).toBe('pending');
    });

    it('ignores duplicate URLs', () => {
      db.insertUrlBatch([{ loc: 'https://autoline.cz/a--1' }], 'sitemap-1.xml');
      db.insertUrlBatch([{ loc: 'https://autoline.cz/a--1' }], 'sitemap-1.xml');

      const counts = db.getUrlCounts();
      expect(counts.total).toBe(1);
    });

    it('respects limit', () => {
      db.insertUrlBatch(
        [{ loc: 'https://autoline.cz/a--1' }, { loc: 'https://autoline.cz/a--2' }, { loc: 'https://autoline.cz/a--3' }],
        'sitemap.xml',
      );

      const pending = db.getPendingUrls(3, 2);
      expect(pending).toHaveLength(2);
    });
  });

  describe('markFailed', () => {
    it('marks URL as failed', () => {
      db.insertUrlBatch([{ loc: 'https://autoline.cz/a--1' }], 'sitemap.xml');
      db.markFailed('https://autoline.cz/a--1', 'timeout');

      const counts = db.getUrlCounts();
      expect(counts.failed).toBe(1);
      expect(counts.pending).toBe(0);
    });

    it('failed URLs with attempts < maxRetries are returned by getPendingUrls', () => {
      db.insertUrlBatch([{ loc: 'https://autoline.cz/a--1' }], 'sitemap.xml');
      db.markFailed('https://autoline.cz/a--1', 'timeout');

      const pending = db.getPendingUrls(3, 10);
      expect(pending).toHaveLength(1);
    });

    it('failed URLs with attempts >= maxRetries are not returned', () => {
      db.insertUrlBatch([{ loc: 'https://autoline.cz/a--1' }], 'sitemap.xml');
      db.markFailed('https://autoline.cz/a--1', 'err1');
      db.markFailed('https://autoline.cz/a--1', 'err2');
      db.markFailed('https://autoline.cz/a--1', 'err3');

      const pending = db.getPendingUrls(3, 10);
      expect(pending).toHaveLength(0);
    });
  });

  describe('markGone', () => {
    it('marks URL as gone', () => {
      db.insertUrlBatch([{ loc: 'https://autoline.cz/a--1' }], 'sitemap.xml');
      db.markGone('https://autoline.cz/a--1');

      const counts = db.getUrlCounts();
      expect(counts.gone).toBe(1);
    });
  });

  describe('saveListing', () => {
    it('saves listing and marks URL as scraped', () => {
      db.insertUrlBatch([{ loc: 'https://autoline.cz/a--1' }], 'sitemap.xml');
      db.saveListing({
        url: 'https://autoline.cz/a--1',
        autoline_id: '1',
        name: 'Test Truck',
        brand: 'Volvo',
        price: 50000,
      });

      const counts = db.getUrlCounts();
      expect(counts.scraped).toBe(1);
    });

    it('saves listing with minimal data', () => {
      db.insertUrlBatch([{ loc: 'https://autoline.cz/a--2' }], 'sitemap.xml');
      db.saveListing({ url: 'https://autoline.cz/a--2' });

      const counts = db.getUrlCounts();
      expect(counts.scraped).toBe(1);
    });
  });

  describe('startRun / finishRun', () => {
    it('creates and finishes a run', () => {
      const runId = db.startRun('detail');
      expect(runId).toBeGreaterThan(0);

      db.finishRun(runId, 100, 90, 10, 'completed');
      // No error = success
    });
  });

  describe('getUrlCounts', () => {
    it('returns all zeros for empty db', () => {
      const counts = db.getUrlCounts();
      expect(counts.total).toBe(0);
      expect(counts.pending).toBe(0);
      expect(counts.scraped).toBe(0);
      expect(counts.failed).toBe(0);
      expect(counts.gone).toBe(0);
    });
  });
});
