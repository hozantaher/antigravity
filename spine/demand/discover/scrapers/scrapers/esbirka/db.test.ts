import { createDb } from './db.js';

describe('esbirka db', () => {
  let db: ReturnType<typeof createDb>;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('inserts URLs, ignores duplicates and gets pending rows', () => {
    db.insertUrlBatch([
      { eli: 'eli/1', citace: '1/2024 Sb.', cislo: '1', rok: 2024, sbirka: 'sb' },
      { eli: 'eli/2', citace: '2/2024 Sb.', cislo: '2', rok: 2024, sbirka: 'sm' },
    ]);
    db.insertUrlBatch([{ eli: 'eli/1', citace: '1/2024 Sb.', cislo: '1', rok: 2024, sbirka: 'sb' }]);

    expect(db.getUrlCounts().total).toBe(2);
    expect(db.getPendingUrls(3, 10)).toHaveLength(2);
    expect(db.getPendingUrls(3, 10, 'sb')).toHaveLength(1);
    expect(db.getPendingUrls(3, 10, 'sm')).toHaveLength(1);
  });

  it('tracks failed/gone statuses and max retry filtering', () => {
    db.insertUrlBatch([{ eli: 'eli/3', citace: '3/2024 Sb.', cislo: '3', rok: 2024, sbirka: 'sb' }]);

    db.markFailed('eli/3', 'timeout-1');
    expect(db.getPendingUrls(2, 10)).toHaveLength(1);

    db.markFailed('eli/3', 'timeout-2');
    expect(db.getPendingUrls(2, 10)).toHaveLength(0);

    db.markGone('eli/3');
    const counts = db.getUrlCounts();
    expect(counts.gone).toBe(1);
  });

  it('saves act, marks URL scraped and returns per-collection counts', () => {
    db.insertUrlBatch([
      { eli: 'eli/4', citace: '4/2024 Sb.', cislo: '4', rok: 2024, sbirka: 'sb' },
      { eli: 'eli/5', citace: '5/2024 Sb.', cislo: '5', rok: 2024, sbirka: 'sm' },
    ]);

    db.saveAct({
      eli: 'eli/4',
      citace: '4/2024 Sb.',
      nazev: 'Test Act',
      fragment_count: 12,
      full_text: 'Body text',
    });

    const totalCounts = db.getUrlCounts();
    expect(totalCounts.scraped).toBe(1);
    expect(totalCounts.pending).toBe(1);

    const sbCounts = db.getUrlCounts('sb');
    expect(sbCounts.scraped).toBe(1);
    expect(sbCounts.total).toBe(1);
    const smCounts = db.getUrlCounts('sm');
    expect(smCounts.pending).toBe(1);
    expect(smCounts.total).toBe(1);
  });

  it('saves minimal act payload and stores nullable fields as null', () => {
    db.insertUrlBatch([{ eli: 'eli/6', citace: '6/2024 Sb.', cislo: '6', rok: 2024, sbirka: 'sb' }]);

    db.saveAct({ eli: 'eli/6' });

    const saved = db.db
      .prepare('SELECT citace, nazev, full_text, fragment_count FROM esbirka_acts WHERE eli = ?')
      .get('eli/6') as {
      citace: string | null;
      nazev: string | null;
      full_text: string | null;
      fragment_count: number | null;
    };

    expect(saved.citace).toBeNull();
    expect(saved.nazev).toBeNull();
    expect(saved.full_text).toBeNull();
    expect(saved.fragment_count).toBeNull();
    expect(db.getUrlCounts().scraped).toBe(1);
  });

  it('creates and finishes scrape runs', () => {
    const runId = db.startRun('detail');
    expect(runId).toBeGreaterThan(0);

    db.finishRun(runId, 10, 8, 2, 'completed');
    // no throw
  });
});
