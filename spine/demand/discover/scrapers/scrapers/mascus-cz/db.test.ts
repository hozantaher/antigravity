import { createDb } from './db.js';

describe('mascus-cz db', () => {
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
        [{ loc: 'https://www.mascus.cz/x/a.html', lastmod: '2024-01-01' }, { loc: 'https://www.mascus.cz/x/b.html' }],
        'sitemap_local_ads_1.xml',
      );

      const pending = db.getPendingUrls(3, 10);
      expect(pending).toHaveLength(2);
      expect(pending[0].url).toBe('https://www.mascus.cz/x/a.html');
      expect(pending[0].status).toBe('pending');
    });

    it('ignores duplicate URLs', () => {
      db.insertUrlBatch([{ loc: 'https://www.mascus.cz/x/a.html' }], 's.xml');
      db.insertUrlBatch([{ loc: 'https://www.mascus.cz/x/a.html' }], 's.xml');

      const counts = db.getUrlCounts();
      expect(counts.total).toBe(1);
    });
  });

  describe('markFailed / markGone', () => {
    it('marks URL as failed', () => {
      db.insertUrlBatch([{ loc: 'https://www.mascus.cz/x/a.html' }], 's.xml');
      db.markFailed('https://www.mascus.cz/x/a.html', 'error');

      const counts = db.getUrlCounts();
      expect(counts.failed).toBe(1);
    });

    it('marks URL as gone', () => {
      db.insertUrlBatch([{ loc: 'https://www.mascus.cz/x/a.html' }], 's.xml');
      db.markGone('https://www.mascus.cz/x/a.html');

      const counts = db.getUrlCounts();
      expect(counts.gone).toBe(1);
    });
  });

  describe('saveListing', () => {
    it('saves listing and marks URL as scraped', () => {
      db.insertUrlBatch([{ loc: 'https://www.mascus.cz/x/a.html' }], 's.xml');
      db.saveListing({
        url: 'https://www.mascus.cz/x/a.html',
        mascus_id: 'a',
        name: 'Test Machine',
        brand: 'CAT',
        price: 100000,
      });

      const counts = db.getUrlCounts();
      expect(counts.scraped).toBe(1);
    });

    it('saves listing with all optional fields null', () => {
      db.insertUrlBatch([{ loc: 'https://www.mascus.cz/x/b.html' }], 's.xml');
      db.saveListing({ url: 'https://www.mascus.cz/x/b.html' });

      const counts = db.getUrlCounts();
      expect(counts.scraped).toBe(1);
    });
  });

  describe('startRun / finishRun', () => {
    it('creates and finishes a run', () => {
      const runId = db.startRun('detail');
      expect(runId).toBeGreaterThan(0);
      db.finishRun(runId, 50, 45, 5, 'completed');
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
