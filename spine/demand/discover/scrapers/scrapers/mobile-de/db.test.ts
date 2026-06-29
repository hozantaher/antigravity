import { createDb } from './db.js';

describe('mobile-de db', () => {
  let db: ReturnType<typeof createDb>;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('insertUrlBatch + getPendingUrls', () => {
    it('inserts URLs and retrieves pending', () => {
      const inserted = db.insertUrlBatch([
        { url: 'https://mobile.de/a?id=1', mobile_id: '1', category: 'Car' },
        { url: 'https://mobile.de/a?id=2', mobile_id: '2', category: 'Car' },
      ]);

      expect(inserted).toBe(2);
      const pending = db.getPendingUrls(3, 10);
      expect(pending).toHaveLength(2);
    });

    it('ignores duplicates and returns count of new inserts', () => {
      db.insertUrlBatch([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', category: 'Car' }]);
      const inserted = db.insertUrlBatch([
        { url: 'https://mobile.de/a?id=1', mobile_id: '1', category: 'Car' },
        { url: 'https://mobile.de/a?id=2', mobile_id: '2', category: 'Car' },
      ]);

      expect(inserted).toBe(1);
    });
  });

  describe('markFailed / markGone', () => {
    it('marks URL as failed', () => {
      db.insertUrlBatch([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', category: 'Car' }]);
      db.markFailed('https://mobile.de/a?id=1', 'timeout');

      const counts = db.getUrlCounts();
      expect(counts.failed).toBe(1);
    });

    it('marks URL as gone', () => {
      db.insertUrlBatch([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', category: 'Car' }]);
      db.markGone('https://mobile.de/a?id=1');

      const counts = db.getUrlCounts();
      expect(counts.gone).toBe(1);
    });
  });

  describe('saveListing', () => {
    it('saves listing and marks URL as scraped', () => {
      db.insertUrlBatch([{ url: 'https://mobile.de/a?id=1', mobile_id: '1', category: 'Car' }]);
      db.saveListing({
        url: 'https://mobile.de/a?id=1',
        mobile_id: '1',
        title: 'BMW 320d',
        price_eur: 25000,
      });

      const counts = db.getUrlCounts();
      expect(counts.scraped).toBe(1);
    });

    it('saves listing with minimal data', () => {
      db.insertUrlBatch([{ url: 'https://mobile.de/a?id=2', mobile_id: '2', category: 'Car' }]);
      db.saveListing({ url: 'https://mobile.de/a?id=2', mobile_id: '2' });

      const counts = db.getUrlCounts();
      expect(counts.scraped).toBe(1);
    });
  });

  describe('search segments', () => {
    it('inserts and retrieves pending segments', () => {
      db.insertSegments([
        { category: 'Car', price_from: 0, price_to: 5000 },
        { category: 'Car', price_from: 5000, price_to: 10000 },
      ]);

      const pending = db.getPendingSegments('Car');
      expect(pending).toHaveLength(2);
      expect(pending[0].price_from).toBe(0);
      expect(pending[0].status).toBe('pending');
    });

    it('ignores duplicate segments', () => {
      db.insertSegments([{ category: 'Car', price_from: 0, price_to: 5000 }]);
      db.insertSegments([{ category: 'Car', price_from: 0, price_to: 5000 }]);

      const pending = db.getPendingSegments('Car');
      expect(pending).toHaveLength(1);
    });

    it('updates segment status', () => {
      db.insertSegments([{ category: 'Car', price_from: 0, price_to: 5000 }]);
      const pending = db.getPendingSegments('Car');
      const segment = pending[0];

      db.updateSegment({
        id: segment.id,
        total_results: 100,
        last_page_scraped: 5,
        total_pages: 10,
        status: 'in_progress',
      });

      const updated = db.getSegment(segment.id);
      expect(updated!.status).toBe('in_progress');
      expect(updated!.total_results).toBe(100);
      expect(updated!.last_page_scraped).toBe(5);
    });

    it('getSegmentCountForCategory returns count', () => {
      db.insertSegments([
        { category: 'Car', price_from: 0, price_to: 5000 },
        { category: 'Car', price_from: 5000, price_to: 10000 },
        { category: 'Truck', price_from: 0, price_to: 5000 },
      ]);

      expect(db.getSegmentCountForCategory('Car')).toBe(2);
      expect(db.getSegmentCountForCategory('Truck')).toBe(1);
    });

    it('getSegmentStats groups by status', () => {
      db.insertSegments([
        { category: 'Car', price_from: 0, price_to: 5000 },
        { category: 'Car', price_from: 5000, price_to: 10000 },
      ]);

      const pending = db.getPendingSegments('Car');
      db.updateSegment({ id: pending[0].id, last_page_scraped: 3, status: 'completed' });

      const stats = db.getSegmentStats('Car');
      expect(stats.pending).toBe(1);
      expect(stats.completed).toBe(1);
    });

    it('deleteSegment removes segment', () => {
      db.insertSegments([{ category: 'Car', price_from: 0, price_to: 5000 }]);
      const pending = db.getPendingSegments('Car');
      db.deleteSegment(pending[0].id);

      expect(db.getSegmentCountForCategory('Car')).toBe(0);
    });

    it('resetSearch clears segments and progress', () => {
      db.insertSegments([{ category: 'Car', price_from: 0, price_to: 5000 }]);
      db.upsertSearchProgress({
        category: 'Car',
        total_results: 100,
        last_page_scraped: 5,
        total_pages: 10,
        status: 'completed',
      });

      db.resetSearch();
      expect(db.getSegmentCountForCategory('Car')).toBe(0);
      expect(db.getSearchProgress('Car')).toBeUndefined();
    });
  });

  describe('search progress', () => {
    it('upserts and retrieves search progress', () => {
      db.upsertSearchProgress({
        category: 'Car',
        total_results: 500,
        last_page_scraped: 3,
        total_pages: 25,
        status: 'in_progress',
      });

      const progress = db.getSearchProgress('Car');
      expect(progress).toBeDefined();
      expect(progress!.total_results).toBe(500);
      expect(progress!.last_page_scraped).toBe(3);
      expect(progress!.status).toBe('in_progress');
    });

    it('updates existing progress on conflict', () => {
      db.upsertSearchProgress({
        category: 'Car',
        total_results: 500,
        last_page_scraped: 3,
        status: 'in_progress',
      });

      db.upsertSearchProgress({
        category: 'Car',
        last_page_scraped: 10,
        status: 'completed',
      });

      const progress = db.getSearchProgress('Car');
      expect(progress!.last_page_scraped).toBe(10);
      expect(progress!.status).toBe('completed');
    });
  });

  describe('startRun / finishRun', () => {
    it('creates and finishes a run', () => {
      const runId = db.startRun('search');
      expect(runId).toBeGreaterThan(0);
      db.finishRun(runId, 200, 180, 20, 'completed');
    });
  });

  describe('getUrlCounts', () => {
    it('returns all zeros for empty db', () => {
      const counts = db.getUrlCounts();
      expect(counts.total).toBe(0);
      expect(counts.pending).toBe(0);
    });
  });
});
