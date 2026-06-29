import { createDb } from './db.js';

describe('judikaty db', () => {
  let db: ReturnType<typeof createDb>;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('insertUrlBatch + getPendingUrls', () => {
    it('inserts URLs and retrieves pending by source', () => {
      db.insertUrlBatch([
        { url: 'https://example.com/1', source: 'justice', external_id: 'uuid-1', ecli: 'ECLI:CZ:1' },
        { url: 'https://example.com/2', source: 'justice' },
        { url: 'https://example.com/3', source: 'usoud' },
      ]);

      const justicePending = db.getPendingUrls('justice', 3, 10);
      expect(justicePending).toHaveLength(2);
      expect(justicePending[0].url).toBe('https://example.com/1');
      expect(justicePending[0].source).toBe('justice');

      const usoudPending = db.getPendingUrls('usoud', 3, 10);
      expect(usoudPending).toHaveLength(1);
      expect(usoudPending[0].url).toBe('https://example.com/3');
    });

    it('ignores duplicate URLs', () => {
      db.insertUrlBatch([{ url: 'https://example.com/1', source: 'justice' }]);
      db.insertUrlBatch([{ url: 'https://example.com/1', source: 'justice' }]);

      const counts = db.getUrlCounts('justice');
      expect(counts.total).toBe(1);
    });

    it('respects limit', () => {
      db.insertUrlBatch([
        { url: 'https://example.com/1', source: 'nsoud' },
        { url: 'https://example.com/2', source: 'nsoud' },
        { url: 'https://example.com/3', source: 'nsoud' },
      ]);

      const pending = db.getPendingUrls('nsoud', 3, 2);
      expect(pending).toHaveLength(2);
    });

    it('stores metadata fields', () => {
      db.insertUrlBatch([
        {
          url: 'https://example.com/1',
          source: 'justice',
          external_id: 'uuid-123',
          ecli: 'ECLI:CZ:OS:2024:1',
          jednaci_cislo: '1 C 100/2024',
          soud: 'Okresní soud v Praze',
          datum_vydani: '2024-01-15',
        },
      ]);

      const pending = db.getPendingUrls('justice', 3, 10);
      expect(pending[0].external_id).toBe('uuid-123');
      expect(pending[0].ecli).toBe('ECLI:CZ:OS:2024:1');
      expect(pending[0].jednaci_cislo).toBe('1 C 100/2024');
      expect(pending[0].soud).toBe('Okresní soud v Praze');
      expect(pending[0].datum_vydani).toBe('2024-01-15');
    });
  });

  describe('markFailed', () => {
    it('marks URL as failed', () => {
      db.insertUrlBatch([{ url: 'https://example.com/1', source: 'justice' }]);
      db.markFailed('https://example.com/1', 'timeout');

      const counts = db.getUrlCounts('justice');
      expect(counts.failed).toBe(1);
      expect(counts.pending).toBe(0);
    });

    it('failed URLs with attempts < maxRetries are returned by getPendingUrls', () => {
      db.insertUrlBatch([{ url: 'https://example.com/1', source: 'usoud' }]);
      db.markFailed('https://example.com/1', 'timeout');

      const pending = db.getPendingUrls('usoud', 3, 10);
      expect(pending).toHaveLength(1);
    });

    it('failed URLs with attempts >= maxRetries are not returned', () => {
      db.insertUrlBatch([{ url: 'https://example.com/1', source: 'nssoud' }]);
      db.markFailed('https://example.com/1', 'err1');
      db.markFailed('https://example.com/1', 'err2');
      db.markFailed('https://example.com/1', 'err3');

      const pending = db.getPendingUrls('nssoud', 3, 10);
      expect(pending).toHaveLength(0);
    });
  });

  describe('markGone', () => {
    it('marks URL as gone', () => {
      db.insertUrlBatch([{ url: 'https://example.com/1', source: 'nsoud' }]);
      db.markGone('https://example.com/1');

      const counts = db.getUrlCounts('nsoud');
      expect(counts.gone).toBe(1);
    });
  });

  describe('saveDecision', () => {
    it('saves decision and marks URL as scraped', () => {
      db.insertUrlBatch([{ url: 'https://example.com/1', source: 'justice' }]);
      db.saveDecision({
        url: 'https://example.com/1',
        source: 'justice',
        ecli: 'ECLI:CZ:OS:2024:1',
        jednaci_cislo: '1 C 100/2024',
        soud: 'Okresní soud',
        vyrok: 'Žaloba se zamítá.',
        oduvodneni: 'Soud rozhodl...',
      });

      const counts = db.getUrlCounts('justice');
      expect(counts.scraped).toBe(1);
    });

    it('saves decision with minimal data', () => {
      db.insertUrlBatch([{ url: 'https://example.com/2', source: 'usoud' }]);
      db.saveDecision({ url: 'https://example.com/2', source: 'usoud' });

      const counts = db.getUrlCounts('usoud');
      expect(counts.scraped).toBe(1);
    });

    it('saves decision with all fields', () => {
      db.insertUrlBatch([{ url: 'https://example.com/3', source: 'nssoud' }]);
      db.saveDecision({
        url: 'https://example.com/3',
        source: 'nssoud',
        external_id: '12345',
        ecli: 'ECLI:CZ:NSS:2024:1',
        jednaci_cislo: '1 As 100/2024',
        spisova_znacka: '1 As 100/2024-50',
        soud: 'Nejvyšší správní soud',
        autor: 'JUDr. Novák',
        datum_vydani: '2024-06-15',
        datum_zverejneni: '2024-06-20',
        typ_rozhodnuti: 'Rozsudek',
        predmet_rizeni: 'Správní řízení',
        oblast_prava: 'Správní právo',
        klicova_slova: '["daně","správní řízení"]',
        zminena_ustanoveni: '["§ 250 o.s.ř."]',
        pravni_veta: 'Právní věta rozhodnutí...',
        vyrok: 'Kasační stížnost se zamítá.',
        oduvodneni: 'Odůvodnění rozhodnutí...',
        raw_json: '{"full":"data"}',
      });

      const counts = db.getUrlCounts('nssoud');
      expect(counts.scraped).toBe(1);
    });
  });

  describe('startRun / finishRun', () => {
    it('creates and finishes a run', () => {
      const runId = db.startRun('justice-detail');
      expect(runId).toBeGreaterThan(0);

      db.finishRun(runId, 100, 90, 10, 'completed');
    });
  });

  describe('getUrlCounts', () => {
    it('returns all zeros for empty source', () => {
      const counts = db.getUrlCounts('justice');
      expect(counts.total).toBe(0);
      expect(counts.pending).toBe(0);
      expect(counts.scraped).toBe(0);
      expect(counts.failed).toBe(0);
      expect(counts.gone).toBe(0);
    });

    it('counts are source-specific', () => {
      db.insertUrlBatch([
        { url: 'https://example.com/1', source: 'justice' },
        { url: 'https://example.com/2', source: 'justice' },
        { url: 'https://example.com/3', source: 'usoud' },
      ]);

      expect(db.getUrlCounts('justice').total).toBe(2);
      expect(db.getUrlCounts('usoud').total).toBe(1);
      expect(db.getUrlCounts('nssoud').total).toBe(0);
    });
  });
});
