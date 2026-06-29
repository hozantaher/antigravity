import {
  fetchAllActs,
  fetchFragments,
  fetchMetadata,
  fetchRelationships,
} from './api.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('esbirka api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches acts from SPARQL endpoint', async () => {
    const payload = {
      head: { vars: ['s', 'citace'] },
      results: { bindings: [{ s: { type: 'uri', value: 'eli/1' }, citace: { type: 'literal', value: '1/2024 Sb.' } }] },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    const result = await fetchAllActs('sb');
    expect(result).toEqual(payload);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('opendata.eselpoint.cz/sparql'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/sparql-results+json',
        }),
      }),
    );
  });

  it('throws detailed error on non-ok SPARQL response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('boom'),
    });

    await expect(fetchAllActs('sb')).rejects.toThrow('SPARQL HTTP 500: boom');
  });

  it('fetches metadata and handles 404 + generic errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ eli: 'eli/1', dokumentBaseId: 1 }),
    });
    await expect(fetchMetadata('eli/1')).resolves.toEqual({ eli: 'eli/1', dokumentBaseId: 1 });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });
    await expect(fetchMetadata('eli/404')).rejects.toThrow('Not found: eli/404');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
    });
    await expect(fetchMetadata('eli/503')).rejects.toThrow('HTTP 503');
  });

  it('fetches fragments and returns null for page-out-of-range', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 400,
      ok: false,
    });
    await expect(fetchFragments('eli/1', 99)).resolves.toBeNull();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ seznam: [{ id: 1 }] }),
    });
    await expect(fetchFragments('eli/1', 1)).resolves.toEqual({ seznam: [{ id: 1 }] });
  });

  it('throws on non-ok fragment and relationship requests', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });
    await expect(fetchFragments('eli/1', 1)).rejects.toThrow('HTTP 500 fetching fragments page 1 for eli/1');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
    });
    await expect(fetchRelationships('eli/1')).rejects.toThrow('HTTP 502 fetching relationships for eli/1');
  });

  it('fetches relationships on ok response', async () => {
    const payload = { souvislosti: [{ eli: 'eli/2' }] };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    });

    await expect(fetchRelationships('eli/1')).resolves.toEqual(payload);
  });
});
