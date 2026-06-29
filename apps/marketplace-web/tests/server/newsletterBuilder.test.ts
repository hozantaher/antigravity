import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendDueNewsletters } from '~/server/utils/newsletterBuilder'
import { claimNewsletterSend, listDueNewsletterUsers } from '~/server/repos/newsletterRepo'
import { recommendForNewsletter } from '~/server/utils/recommendation/serve'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { captureServerError } from '~/server/utils/observability'

vi.mock('~/server/repos/newsletterRepo', () => ({ listDueNewsletterUsers: vi.fn(), claimNewsletterSend: vi.fn() }))
vi.mock('~/server/utils/recommendation/serve', () => ({ recommendForNewsletter: vi.fn() }))
vi.mock('~/server/utils/emailQueue', () => ({ enqueueEmail: vi.fn() }))
vi.mock('~/server/email/itemImage', () => ({ emailItemImageUrl: (s: string) => s }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn() }))

// Mocks for the serve.ts suite below (newsletterBuilder above stubs serve wholesale, so these
// repo/pool mocks never touch its tests). itemRepo/recommendationRepo/pool are the only IO.
vi.mock('~/server/repos/itemRepo', () => ({
  loadCardsByIds: vi.fn(),
  listItemsPage: vi.fn(),
}))
vi.mock('~/server/repos/recommendationRepo', () => ({
  GLOBAL_SEGMENT: 'global',
  popularitySegmentKey: (dim: string, value: string) => `${dim}:${value}`,
  getPopularitySegment: vi.fn(),
  getVisitorProfile: vi.fn(),
  getConvertedItemIds: vi.fn(),
  getItemFeaturesMap: vi.fn(),
  loadAnchorAffinity: vi.fn(),
  loadItemAttrs: vi.fn(),
}))
vi.mock('~/server/utils/recommendation/pool', () => ({
  getScorablePool: vi.fn(),
  getServingFeatures: vi.fn(),
  poolRowToCandidate: vi.fn(),
}))

const g = globalThis as any

const item = (id: string, over = {}): any => ({
  id,
  title: `Vehicle ${id}`,
  image: '',
  bids: [],
  priceFrom: { amount: 500_000 },
  endDate: Date.now() + 10 * 86_400_000,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  g.useRuntimeConfig = () => ({ public: { baseUrl: 'http://t' }, internalApiSecret: 'secret' })
})

describe('sendDueNewsletters', () => {
  it('claims, builds and enqueues a localized email for a due user with items', async () => {
    vi.mocked(listDueNewsletterUsers).mockResolvedValue([{ id: 'u1', email: 'u1@x.cz', languageCode: 'cz' }])
    vi.mocked(claimNewsletterSend).mockResolvedValue(true)
    vi.mocked(recommendForNewsletter).mockResolvedValue([item('a'), item('b')])

    const res = await sendDueNewsletters()

    expect(claimNewsletterSend).toHaveBeenCalledWith('u1', expect.any(Number))
    expect(enqueueEmail).toHaveBeenCalledTimes(1)
    const [input, opts] = vi.mocked(enqueueEmail).mock.calls[0]!
    expect(input).toMatchObject({ recipient: 'u1@x.cz', templateKey: 'newsletter', language: 'cz' })
    expect(input.params!.recommendedItems).toHaveLength(2)
    expect(input.params!.unsubscribeUrl).toContain('/api/newsletter/unsubscribe?token=u1.')
    expect(opts!.dedupKey).toContain('newsletter:u1:')
    expect(res).toMatchObject({ due: 1, sent: 1, skippedNoItems: 0, errored: 0 })
  })

  it('localizes item URLs to the recipient locale (prefix for non-default)', async () => {
    vi.mocked(listDueNewsletterUsers).mockResolvedValue([{ id: 'u1', email: 'e', languageCode: 'de' }])
    vi.mocked(claimNewsletterSend).mockResolvedValue(true)
    vi.mocked(recommendForNewsletter).mockResolvedValue([item('a')])
    await sendDueNewsletters()
    const [input] = vi.mocked(enqueueEmail).mock.calls[0]!
    expect(input.params!.recommendedItems![0]!.url).toBe('http://t/de/item/a')
  })

  it('keeps item URLs unprefixed for the default cz locale', async () => {
    vi.mocked(listDueNewsletterUsers).mockResolvedValue([{ id: 'u1', email: 'e', languageCode: 'cz' }])
    vi.mocked(claimNewsletterSend).mockResolvedValue(true)
    vi.mocked(recommendForNewsletter).mockResolvedValue([item('a')])
    await sendDueNewsletters()
    const [input] = vi.mocked(enqueueEmail).mock.calls[0]!
    expect(input.params!.recommendedItems![0]!.url).toBe('http://t/item/a')
  })

  it('skips a due user with no eligible items (without enqueuing)', async () => {
    vi.mocked(listDueNewsletterUsers).mockResolvedValue([{ id: 'u1', email: 'e', languageCode: null }])
    vi.mocked(claimNewsletterSend).mockResolvedValue(true)
    vi.mocked(recommendForNewsletter).mockResolvedValue([])

    const res = await sendDueNewsletters()
    expect(enqueueEmail).not.toHaveBeenCalled()
    expect(res.skippedNoItems).toBe(1)
  })

  it('does not double-send when the claim is lost (CAS false)', async () => {
    vi.mocked(listDueNewsletterUsers).mockResolvedValue([{ id: 'u1', email: 'e', languageCode: 'cz' }])
    vi.mocked(claimNewsletterSend).mockResolvedValue(false)

    await sendDueNewsletters()
    expect(recommendForNewsletter).not.toHaveBeenCalled()
    expect(enqueueEmail).not.toHaveBeenCalled()
  })

  it('dryRun computes selection without claiming or sending', async () => {
    vi.mocked(listDueNewsletterUsers).mockResolvedValue([{ id: 'u1', email: 'e', languageCode: 'cz' }])
    vi.mocked(recommendForNewsletter).mockResolvedValue([item('a')])

    const res = await sendDueNewsletters({ dryRun: true })
    expect(claimNewsletterSend).not.toHaveBeenCalled()
    expect(enqueueEmail).not.toHaveBeenCalled()
    expect(res.sent).toBe(1)
  })

  it('respects a custom batch limit and forwards it to the repo', async () => {
    vi.mocked(listDueNewsletterUsers).mockResolvedValue([])
    const res = await sendDueNewsletters({ limit: 7 })
    expect(listDueNewsletterUsers).toHaveBeenCalledWith(expect.any(Number), 7)
    expect(res).toMatchObject({ due: 0, sent: 0, skippedNoItems: 0, errored: 0 })
  })

  it('drops items ending before the defensive horizon and skips when none remain', async () => {
    vi.mocked(listDueNewsletterUsers).mockResolvedValue([{ id: 'u1', email: 'e', languageCode: 'cz' }])
    vi.mocked(claimNewsletterSend).mockResolvedValue(true)
    // endDate inside the 48h horizon → filtered out → skippedNoItems.
    vi.mocked(recommendForNewsletter).mockResolvedValue([item('soon', { endDate: Date.now() + 60_000 })])

    const res = await sendDueNewsletters()
    expect(enqueueEmail).not.toHaveBeenCalled()
    expect(res.skippedNoItems).toBe(1)
  })

  it('builds a card without endDate/price (ad item) — optional fields undefined', async () => {
    vi.mocked(listDueNewsletterUsers).mockResolvedValue([{ id: 'u1', email: 'e', languageCode: 'cz' }])
    vi.mocked(claimNewsletterSend).mockResolvedValue(true)
    vi.mocked(recommendForNewsletter).mockResolvedValue([
      item('ad', { endDate: undefined, priceFrom: undefined, bids: [] }),
    ])

    await sendDueNewsletters()
    const [input] = vi.mocked(enqueueEmail).mock.calls[0]!
    const card = input.params!.recommendedItems![0]!
    expect(card.endsAt).toBeUndefined()
    expect(card.url).toBe('http://t/item/ad')
  })

  it('counts an error and captures it when enqueue rejects (per-user isolation)', async () => {
    vi.mocked(listDueNewsletterUsers).mockResolvedValue([
      { id: 'u1', email: 'a@x', languageCode: 'cz' },
      { id: 'u2', email: 'b@x', languageCode: 'cz' },
    ])
    vi.mocked(claimNewsletterSend).mockResolvedValue(true)
    vi.mocked(recommendForNewsletter).mockResolvedValue([item('a')])
    vi.mocked(enqueueEmail).mockRejectedValueOnce(new Error('queue down')).mockResolvedValueOnce(undefined)

    const res = await sendDueNewsletters()
    expect(captureServerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'newsletter.send', tags: { userId: 'u1' } }),
    )
    expect(res).toMatchObject({ due: 2, sent: 1, errored: 1 })
  })
})

describe('unsubscribeToken / verifyUnsubscribeToken', () => {
  it('round-trips a token and rejects a tampered or malformed one', async () => {
    const { unsubscribeToken, verifyUnsubscribeToken } = await import('~/server/utils/newsletterBuilder')
    const token = unsubscribeToken('user-42')
    expect(token.startsWith('user-42.')).toBe(true)
    expect(verifyUnsubscribeToken(token)).toBe('user-42')
    expect(verifyUnsubscribeToken(`${token}x`)).toBeNull()
    expect(verifyUnsubscribeToken('nodothere')).toBeNull()
    expect(verifyUnsubscribeToken('.leadingdot')).toBeNull()
  })

  it('recovers the userId even when it contains dots (lastIndexOf split)', async () => {
    const { unsubscribeToken, verifyUnsubscribeToken } = await import('~/server/utils/newsletterBuilder')
    const token = unsubscribeToken('a.b.c')
    expect(verifyUnsubscribeToken(token)).toBe('a.b.c')
  })
})

describe('reco utils (server/utils/reco.ts)', () => {
  const importReco = () => import('~/server/utils/reco')

  it('isRecoEnabled reflects runtime config (true / false / missing)', async () => {
    const { isRecoEnabled } = await importReco()
    g.useRuntimeConfig = () => ({ public: { recoEnabled: true } })
    expect(isRecoEnabled()).toBe(true)
    g.useRuntimeConfig = () => ({ public: { recoEnabled: false } })
    expect(isRecoEnabled()).toBe(false)
    g.useRuntimeConfig = () => ({ public: {} })
    expect(isRecoEnabled()).toBe(false)
  })

  it('parseRecoLimit clamps, truncates, and falls back on non-finite', async () => {
    const { parseRecoLimit } = await importReco()
    const evt = (limit: unknown): any => ({ context: { query: { limit } } })
    g.getQuery = (e: any) => e.context.query
    // below floor (4)
    expect(parseRecoLimit(evt('2'))).toBe(4)
    // within bounds, truncated
    expect(parseRecoLimit(evt('9.9'))).toBe(9)
    // above ceiling (servingMaxN = 24)
    expect(parseRecoLimit(evt('1000'))).toBe(24)
    // non-finite → servingDefaultN (12)
    expect(parseRecoLimit(evt('abc'))).toBe(12)
    expect(parseRecoLimit(evt(undefined))).toBe(12)
  })
})

describe('recommendation/serve.ts', () => {
  let serve: typeof import('~/server/utils/recommendation/serve')
  let itemRepo: typeof import('~/server/repos/itemRepo')
  let recoRepo: typeof import('~/server/repos/recommendationRepo')
  let pool: typeof import('~/server/utils/recommendation/pool')
  let ItemStatus: typeof import('~/models').ItemStatus

  // A scorable candidate with a non-trivial vector so cosineSim/MMR exercise real branches.
  const cand = (id: string, over: Partial<any> = {}): any => ({
    id,
    categoryId: 'cat1',
    countryCode: 'cz',
    status: ItemStatus.AuctionLive,
    endMs: Date.now() + 30 * 86_400_000,
    attrs: {
      categorical: { categoryId: 'cat1', type: 'auction', make: 'BMW', bodyType: 'sedan' },
      numeric: { price: 500_000, year: 2020 },
    },
    vector: { 'cat:cat1': 1, 'make:BMW': 1, 'body:sedan': 1 },
    make: 'BMW',
    ...over,
  })

  const card = (id: string): any => ({ id, title: `t${id}`, image: '', bids: [], priceFrom: { amount: 1 } })

  beforeEach(async () => {
    serve = await vi.importActual('~/server/utils/recommendation/serve')
    itemRepo = await import('~/server/repos/itemRepo')
    recoRepo = await import('~/server/repos/recommendationRepo')
    pool = await import('~/server/utils/recommendation/pool')
    ;({ ItemStatus } = await import('~/models'))
    g.useRuntimeConfig = () => ({ public: { recoEnabled: true } })

    vi.mocked(recoRepo.getVisitorProfile).mockResolvedValue(undefined)
    vi.mocked(recoRepo.getConvertedItemIds).mockResolvedValue(new Set())
    vi.mocked(recoRepo.getItemFeaturesMap).mockResolvedValue(new Map())
    vi.mocked(pool.getServingFeatures).mockResolvedValue(new Map())
    vi.mocked(recoRepo.loadAnchorAffinity).mockResolvedValue(new Map())
    vi.mocked(recoRepo.loadItemAttrs).mockResolvedValue(new Map())
    vi.mocked(recoRepo.getPopularitySegment).mockResolvedValue([])
    vi.mocked(itemRepo.loadCardsByIds).mockImplementation(async (ids: string[]) => ids.map(card))
    vi.mocked(itemRepo.listItemsPage).mockResolvedValue({ items: [], total: 0 } as any)
    vi.mocked(pool.poolRowToCandidate).mockImplementation((row: any) => cand(row.id))
  })

  describe('recommendForItem', () => {
    it('returns scored cards for an in-pool anchor with profile + affinity + features', async () => {
      vi.mocked(pool.getScorablePool).mockResolvedValue([cand('anchor'), cand('a'), cand('b'), cand('c')])
      vi.mocked(recoRepo.getVisitorProfile).mockResolvedValue({
        vid: 'v1',
        alpha: 0.5,
        features: { categorical: { make: { BMW: 1 } }, numeric: {} },
        updatedAt: new Date(),
      } as any)
      vi.mocked(recoRepo.loadAnchorAffinity).mockResolvedValue(new Map([['make', new Map([['BMW', 0.9]])]]))
      vi.mocked(pool.getServingFeatures).mockResolvedValue(
        new Map([['a', { itemId: 'a', trendScore: 0.5, qualityScore: 0.5, popularityScore: 0.5 }]]) as any,
      )
      vi.mocked(recoRepo.getPopularitySegment).mockResolvedValue([
        { itemId: 'a', score: 10 },
        { itemId: 'b', score: 5 },
      ] as any)

      const res = await serve.recommendForItem({ anchorId: 'anchor', vid: 'v1', userId: 'u1', limit: 6, country: 'cz' })
      expect(res.length).toBeGreaterThan(0)
      expect(res.map(r => r.id)).not.toContain('anchor')
    })

    it('falls back to popularity ids when the anchor produces no rankable pool', async () => {
      // pool only contains the anchor → after exclusion, scored is empty → fallback chain.
      vi.mocked(pool.getScorablePool).mockResolvedValue([cand('anchor')])
      vi.mocked(recoRepo.getPopularitySegment).mockImplementation(async (key: string) =>
        key === 'global' ? ([{ itemId: 'p1', score: 1 }] as any) : [],
      )
      const res = await serve.recommendForItem({ anchorId: 'anchor', limit: 6 })
      expect(res.map(r => r.id)).toContain('p1')
    })

    it('loads anchor attrs from the repo when the anchor is not in the pool', async () => {
      vi.mocked(pool.getScorablePool).mockResolvedValue([cand('a'), cand('b')])
      vi.mocked(recoRepo.loadItemAttrs).mockResolvedValue(
        new Map([
          ['anchor', { id: 'anchor', categoryId: 'cat1', type: 'auction', specs: { manufacturer: 'BMW' } }],
        ]) as any,
      )
      const res = await serve.recommendForItem({ anchorId: 'anchor', limit: 6 })
      expect(recoRepo.loadItemAttrs).toHaveBeenCalledWith(['anchor'])
      expect(pool.poolRowToCandidate).toHaveBeenCalled()
      expect(res.length).toBeGreaterThan(0)
    })

    it('handles a missing anchor (no pool row, no attrs row) — anchor stays null', async () => {
      vi.mocked(pool.getScorablePool).mockResolvedValue([cand('a'), cand('b')])
      vi.mocked(recoRepo.loadItemAttrs).mockResolvedValue(new Map())
      const res = await serve.recommendForItem({ anchorId: 'ghost', limit: 6 })
      expect(res.length).toBeGreaterThan(0)
    })

    it('uses the fallback chain when reco is disabled', async () => {
      g.useRuntimeConfig = () => ({ public: { recoEnabled: false } })
      vi.mocked(recoRepo.getPopularitySegment).mockResolvedValue([{ itemId: 'p1', score: 1 }] as any)
      const res = await serve.recommendForItem({ anchorId: 'x', limit: 6 })
      expect(res.map(r => r.id)).toContain('p1')
      expect(pool.getScorablePool).not.toHaveBeenCalled()
    })

    it('degrades to [] when the fallback chain itself throws (catch in safeFallback)', async () => {
      g.useRuntimeConfig = () => ({ public: { recoEnabled: false } })
      vi.mocked(recoRepo.getPopularitySegment).mockRejectedValue(new Error('db'))
      const res = await serve.recommendForItem({ anchorId: 'x', limit: 6 })
      expect(res).toEqual([])
    })

    it('degrades to fallback and captures the error when the engine throws', async () => {
      vi.mocked(pool.getScorablePool).mockRejectedValue(new Error('pool boom'))
      // fallback then succeeds via popularity
      vi.mocked(recoRepo.getPopularitySegment).mockImplementation(async (key: string) =>
        key === 'global' ? ([{ itemId: 'p1', score: 1 }] as any) : [],
      )
      const res = await serve.recommendForItem({ anchorId: 'x', limit: 6 })
      expect(res.map(r => r.id)).toContain('p1')
      expect(captureServerError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ area: 'reco.serve.item' }),
      )
    })

    it('fallback newest-active path when popularity is empty but pool has items', async () => {
      vi.mocked(pool.getScorablePool).mockResolvedValue([cand('anchor')])
      // popularity empty everywhere
      vi.mocked(recoRepo.getPopularitySegment).mockResolvedValue([])
      // safeFallback: popIds empty → newest from pool. Give a separate non-anchor pool the 2nd call.
      vi.mocked(pool.getScorablePool)
        .mockResolvedValueOnce([cand('anchor')]) // serving path
        .mockResolvedValueOnce([cand('n1'), cand('n2', { endMs: Date.now() + 1000 })]) // fallback path
      const res = await serve.recommendForItem({ anchorId: 'anchor', limit: 6 })
      expect(res.map(r => r.id).sort()).toEqual(['n1', 'n2'])
    })

    it('fallback listItemsPage path when popularity and newest both yield nothing', async () => {
      vi.mocked(pool.getScorablePool)
        .mockResolvedValueOnce([cand('anchor')])
        .mockResolvedValueOnce([cand('anchor')]) // fallback pool = only excluded id → newestIds empty
      vi.mocked(recoRepo.getPopularitySegment).mockResolvedValue([])
      vi.mocked(itemRepo.listItemsPage).mockResolvedValue({
        items: [card('page1'), { ...card('anchor') }],
        total: 2,
      } as any)
      const res = await serve.recommendForItem({ anchorId: 'anchor', limit: 6 })
      expect(res.map(r => r.id)).toEqual(['page1'])
    })

    it('falls back when scored ids hydrate to zero cards', async () => {
      vi.mocked(pool.getScorablePool).mockResolvedValue([cand('anchor'), cand('a')])
      // first loadCardsByIds (scored) returns [], fallback popularity returns p1
      vi.mocked(itemRepo.loadCardsByIds)
        .mockResolvedValueOnce([])
        .mockResolvedValue([card('p1')])
      vi.mocked(recoRepo.getPopularitySegment).mockImplementation(async (key: string) =>
        key === 'global' ? ([{ itemId: 'p1', score: 1 }] as any) : [],
      )
      const res = await serve.recommendForItem({ anchorId: 'anchor', limit: 6 })
      expect(res.map(r => r.id)).toContain('p1')
    })
  })

  describe('recommendForHome', () => {
    it('returns scored cards (anchor-less) for a populated pool', async () => {
      vi.mocked(pool.getScorablePool).mockResolvedValue([cand('a'), cand('b'), cand('c')])
      const res = await serve.recommendForHome({ vid: 'v1', limit: 6 })
      expect(res.length).toBeGreaterThan(0)
    })

    it('falls back when the pool is empty', async () => {
      vi.mocked(pool.getScorablePool).mockResolvedValue([])
      vi.mocked(recoRepo.getPopularitySegment).mockResolvedValue([{ itemId: 'p1', score: 1 }] as any)
      const res = await serve.recommendForHome({ limit: 6 })
      expect(res.map(r => r.id)).toContain('p1')
    })

    it('uses fallback when reco disabled', async () => {
      g.useRuntimeConfig = () => ({ public: { recoEnabled: false } })
      vi.mocked(recoRepo.getPopularitySegment).mockResolvedValue([{ itemId: 'p1', score: 1 }] as any)
      const res = await serve.recommendForHome({ limit: 6, country: 'cz' })
      expect(res.map(r => r.id)).toContain('p1')
    })

    it('degrades and captures on engine throw', async () => {
      vi.mocked(pool.getScorablePool).mockRejectedValue(new Error('boom'))
      const res = await serve.recommendForHome({ limit: 6 })
      expect(res).toEqual([])
      expect(captureServerError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ area: 'reco.serve.home' }),
      )
    })

    it('falls back via listItemsPage when pool and popularity are both empty (ids === 0)', async () => {
      vi.mocked(pool.getScorablePool).mockResolvedValue([])
      vi.mocked(recoRepo.getPopularitySegment).mockResolvedValue([])
      vi.mocked(itemRepo.listItemsPage).mockResolvedValue({ items: [card('lp')], total: 1 } as any)
      const res = await serve.recommendForHome({ limit: 6 })
      expect(res.map(r => r.id)).toEqual(['lp'])
    })

    it('hydrate-zero on home falls back', async () => {
      vi.mocked(pool.getScorablePool).mockResolvedValue([cand('a')])
      vi.mocked(itemRepo.loadCardsByIds)
        .mockResolvedValueOnce([])
        .mockResolvedValue([card('p1')])
      vi.mocked(recoRepo.getPopularitySegment).mockResolvedValue([{ itemId: 'p1', score: 1 }] as any)
      const res = await serve.recommendForHome({ limit: 6 })
      expect(res.map(r => r.id)).toContain('p1')
    })
  })

  describe('recommendForNewsletter', () => {
    it('returns [] when reco disabled', async () => {
      g.useRuntimeConfig = () => ({ public: { recoEnabled: false } })
      const res = await serve.recommendForNewsletter({ userId: 'u1', limit: 8, sendAtMs: Date.now() })
      expect(res).toEqual([])
      expect(pool.getScorablePool).not.toHaveBeenCalled()
    })

    it('selects horizon-eligible cards and excludes too-soon auctions', async () => {
      const now = Date.now()
      vi.mocked(pool.getScorablePool).mockResolvedValue([
        cand('ok', { endMs: now + 30 * 86_400_000 }),
        cand('soon', { endMs: now + 60_000 }), // inside 48h horizon → gated out
      ])
      const res = await serve.recommendForNewsletter({ userId: 'u1', limit: 8, sendAtMs: now })
      expect(res.map(r => r.id)).toContain('ok')
      expect(res.map(r => r.id)).not.toContain('soon')
    })

    it('returns [] and captures on engine throw', async () => {
      vi.mocked(pool.getScorablePool).mockRejectedValue(new Error('nl boom'))
      const res = await serve.recommendForNewsletter({ userId: 'u1', limit: 8, sendAtMs: Date.now() })
      expect(res).toEqual([])
      expect(captureServerError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ area: 'reco.serve.newsletter', tags: { userId: 'u1' } }),
      )
    })

    it('excludes converted items via getConvertedItemIds', async () => {
      const now = Date.now()
      vi.mocked(pool.getScorablePool).mockResolvedValue([cand('keep'), cand('bought')])
      vi.mocked(recoRepo.getConvertedItemIds).mockResolvedValue(new Set(['bought']))
      const res = await serve.recommendForNewsletter({ userId: 'u1', limit: 8, sendAtMs: now })
      expect(res.map(r => r.id)).toContain('keep')
      expect(res.map(r => r.id)).not.toContain('bought')
    })
  })
})
