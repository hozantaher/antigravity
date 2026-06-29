describe('web-search', () => {
  const originalEnv = { ...process.env };
  let searchWeb: typeof import('./web-search.js').searchWeb;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    process.env.SEARXNG_URL = 'http://searxng.test:8080';
    const mod = await import('./web-search.js');
    searchWeb = mod.searchWeb;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it('returns formatted results on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            { title: 'Result 1', url: 'https://example.com/1', content: 'Content 1' },
            { title: 'Result 2', url: 'https://example.com/2', content: 'Content 2' },
          ],
        }),
    });

    const result = await searchWeb('test query');
    expect(result).toContain('1. Result 1');
    expect(result).toContain('https://example.com/1');
    expect(result).toContain('Content 1');
    expect(result).toContain('2. Result 2');
  });

  it('passes correct query parameters to SearXNG', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ results: [] }) });

    await searchWeb('české právo');
    const url = new URL(mockFetch.mock.calls[0][0].toString());
    expect(url.origin).toBe('http://searxng.test:8080');
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('české právo');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('language')).toBe('cs');
    expect(url.searchParams.get('categories')).toBe('general');
  });

  it('returns "not available" when SEARXNG_URL is not set', async () => {
    delete process.env.SEARXNG_URL;
    vi.resetModules();
    const mod = await import('./web-search.js');
    const result = await mod.searchWeb('test');
    expect(result).toContain('not available');
  });

  it('returns "no results" when results array is empty', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ results: [] }) });
    const result = await searchWeb('nonexistent');
    expect(result).toContain('No web results found');
  });

  it('truncates to 5 results', async () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: `Content ${i}`,
    }));
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ results }) });

    const result = await searchWeb('test');
    expect(result).toContain('5. Result 4');
    expect(result).not.toContain('6.');
  });

  it('handles missing content field', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [{ title: 'No content', url: 'https://example.com' }] }),
    });

    const result = await searchWeb('test');
    expect(result).toContain('No content');
    expect(result).toContain('https://example.com');
  });

  it('returns graceful message on network error', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'));
    const result = await searchWeb('test');
    expect(result).toContain('temporarily unavailable');
  });

  it('retries on 5xx errors', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [{ title: 'OK', url: 'https://ok.com' }] }) });

    const result = await searchWeb('test');
    expect(result).toContain('OK');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on timeout errors', async () => {
    const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    mockFetch
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [{ title: 'OK', url: 'https://ok.com' }] }) });

    const result = await searchWeb('test');
    expect(result).toContain('OK');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on network TypeError', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [{ title: 'OK', url: 'https://ok.com' }] }) });

    const result = await searchWeb('test');
    expect(result).toContain('OK');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx errors', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const result = await searchWeb('test');
    expect(result).toContain('temporarily unavailable');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns graceful message after all retries fail', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const result = await searchWeb('test');
    expect(result).toContain('temporarily unavailable');
    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
