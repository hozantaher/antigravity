import { generateYearRanges } from './utils.js';

describe('judikaty utils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates descending annual ranges from current year to start year (inclusive)', () => {
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000Z'));

    expect(generateYearRanges(2024)).toEqual([
      { from: '01.01.2026', to: '31.12.2026', label: '2026' },
      { from: '01.01.2025', to: '31.12.2025', label: '2025' },
      { from: '01.01.2024', to: '31.12.2024', label: '2024' },
    ]);
  });

  it('returns empty array when start year is in the future', () => {
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000Z'));
    expect(generateYearRanges(2027)).toEqual([]);
  });
});
