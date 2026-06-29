import { randomFrom, fetchPage, USER_AGENTS, ACCEPT_LANGUAGES } from './fetch.js';

describe('randomFrom', () => {
  it('returns an element from the array', () => {
    const arr = [1, 2, 3, 4, 5];
    const result = randomFrom(arr);
    expect(arr).toContain(result);
  });

  it('works with array of length 1', () => {
    expect(randomFrom(['only'])).toBe('only');
  });

  it('works with string arrays', () => {
    const result = randomFrom(USER_AGENTS);
    expect(USER_AGENTS).toContain(result);
  });
});

describe('fetchPage', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns status and html for 200 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('<html>test</html>'),
      headers: new Headers(),
    });

    const result = await fetchPage('https://example.com');
    expect(result.status).toBe(200);
    expect(result.html).toBe('<html>test</html>');
    expect(result.retryAfter).toBeUndefined();
  });

  it('parses retry-after header', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 429,
      text: () => Promise.resolve(''),
      headers: new Headers({ 'retry-after': '30' }),
    });

    const result = await fetchPage('https://example.com');
    expect(result.status).toBe(429);
    expect(result.retryAfter).toBe(30);
  });

  it('handles invalid retry-after header', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 429,
      text: () => Promise.resolve(''),
      headers: new Headers({ 'retry-after': 'invalid' }),
    });

    const result = await fetchPage('https://example.com');
    expect(result.retryAfter).toBeUndefined();
  });

  it('passes custom referers', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    await fetchPage('https://example.com', ['https://custom.com/']);
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://example.com');
    // Verify headers were set
    const headers = call[1].headers;
    expect(headers['User-Agent']).toBeDefined();
    expect(headers['Accept-Language']).toBeDefined();
  });

  it('omits Referer header when selected referer is empty', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    await fetchPage('https://example.com', ['']);
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Referer).toBeUndefined();
  });

  it('sets abort signal timeout', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('ok'),
      headers: new Headers(),
    });

    await fetchPage('https://example.com');
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].signal).toBeDefined();
  });

  it('exports ACCEPT_LANGUAGES', () => {
    expect(ACCEPT_LANGUAGES.length).toBeGreaterThan(0);
    expect(ACCEPT_LANGUAGES[0]).toContain('cs');
  });
});
