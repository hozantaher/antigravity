import { createDb } from './db.js';

describe('firmy-cz db', () => {
  let db: ReturnType<typeof createDb>;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('parses URL forms during insertion and ignores duplicates', () => {
    db.insertUrlBatch(
      [
        'https://www.firmy.cz/detail/123-alpha-sro.html',
        'https://www.firmy.cz/neoverena-firma/456-beta-as.html',
      ],
      'sitemap-1.xml',
    );
    db.insertUrlBatch(['https://www.firmy.cz/detail/123-alpha-sro.html'], 'sitemap-1.xml');

    const pending = db.getPendingUrls(3, 10);
    expect(pending).toHaveLength(2);
    expect(pending[0].firmy_id).toBe(123);
    expect(pending[0].url_type).toBe('detail');
    expect(pending[1].firmy_id).toBe(456);
    expect(pending[1].url_type).toBe('unverified');
    expect(db.getUrlCounts().total).toBe(2);
  });

  it('tracks failed/gone URLs and retry visibility', () => {
    const url = 'https://www.firmy.cz/detail/321-gamma-sro.html';
    db.insertUrlBatch([url], 'sitemap.xml');

    db.markFailed(url, 'err-1');
    expect(db.getPendingUrls(2, 10)).toHaveLength(1);

    db.markFailed(url, 'err-2');
    expect(db.getPendingUrls(2, 10)).toHaveLength(0);

    db.markGone(url);
    expect(db.getUrlCounts().gone).toBe(1);
  });

  it('saves business and marks URL as scraped', () => {
    const url = 'https://www.firmy.cz/detail/789-delta-sro.html';
    db.insertUrlBatch([url], 'sitemap.xml');

    db.saveBusiness({
      url,
      firmy_id: 789,
      url_type: 'detail',
      name: 'Delta s.r.o.',
      ico: '12345678',
      email: 'info@delta.cz',
      latitude: 49.2,
      longitude: 16.6,
    });

    const counts = db.getUrlCounts();
    expect(counts.scraped).toBe(1);
    expect(counts.pending).toBe(0);
  });

  it('stores unmatched URL patterns with null metadata', () => {
    const url = 'https://www.firmy.cz/katalog/neznamy-zaznam';
    db.insertUrlBatch([url], 'sitemap.xml');

    const [row] = db.getPendingUrls(1, 10);
    expect(row.firmy_id).toBeNull();
    expect(row.slug).toBeNull();
    expect(row.url_type).toBeNull();
  });

  it('persists minimal business payload with null optional fields', () => {
    const url = 'https://www.firmy.cz/detail/1000-minimal.html';
    db.insertUrlBatch([url], 'sitemap.xml');

    db.saveBusiness({ url });

    const saved = db.db
      .prepare(
        'SELECT firmy_id, url_type, name, email, latitude, longitude FROM firmy_cz_businesses WHERE url = ?',
      )
      .get(url) as {
      firmy_id: number | null;
      url_type: string | null;
      name: string | null;
      email: string | null;
      latitude: number | null;
      longitude: number | null;
    };

    expect(saved.firmy_id).toBeNull();
    expect(saved.url_type).toBeNull();
    expect(saved.name).toBeNull();
    expect(saved.email).toBeNull();
    expect(saved.latitude).toBeNull();
    expect(saved.longitude).toBeNull();
  });

  it('creates and finishes scrape runs', () => {
    const runId = db.startRun('detail');
    expect(runId).toBeGreaterThan(0);

    db.finishRun(runId, 100, 90, 10, 'completed');
    // no throw
  });
});
