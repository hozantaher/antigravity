import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

import { ItemType } from '~/models'
import { db } from '~/server/utils/db'
import * as userRepo from '~/server/repos/userRepo'
import * as itemRepo from '~/server/repos/itemRepo'
import { enrichListings } from '~/server/utils/enrichListings'
import { decodeVinRemote } from '~/server/utils/vincario'
import { normalizeVinDecode } from '~/server/utils/vincarioNormalize'
import { getCachedVinDecode } from '~/server/repos/vinDecodeRepo'
import { translateTexts } from '~/server/utils/deepl'

// enrichListings reads keys via the bare useRuntimeConfig() global (Nitro auto-import). In the
// node integration env it isn't installed, so stub it ON so vincario/deepl are "configured".
vi.stubGlobal('useRuntimeConfig', () => ({ vincarioApiKey: 'k', vincarioSecretKey: 's', deeplApiKey: 'd' }))

// Mock the external-service modules so the sweep's ORCHESTRATION (claim-CAS, empty-field merge,
// status transitions) is exercised against the real DB without any network call. db + itemRepo stay real.
vi.mock('~/server/utils/vincario', () => ({ decodeVinRemote: vi.fn() }))
vi.mock('~/server/utils/vincarioNormalize', () => ({
  normalizeVinDecode: vi.fn(),
  countNormalizedFields: vi.fn(() => 5),
}))
vi.mock('~/server/repos/vinDecodeRepo', () => ({ getCachedVinDecode: vi.fn(), insertVinDecodeCache: vi.fn() }))
vi.mock('~/server/utils/deepl', () => ({ translateTexts: vi.fn() }))

const RUN = !!process.env.POSTGRES_URL
const UID = 'itest-sweep-u1'

const cleanup = async () => {
  await db.deleteFrom('items').where('id', 'like', 'itest-sweep-%').execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-sweep-%').execute()
}

const stateOf = (id: string) =>
  db.selectFrom('items').select(['enrichmentStatus', 'enrichmentAttempts']).where('id', '=', id).executeTakeFirst()

describe.skipIf(!RUN)('enrichListings sweep (Postgres, externals mocked)', () => {
  beforeAll(async () => {
    await cleanup()
    await userRepo.createOrGetUser({ uid: UID, email: 'itest-sweep@example.test', name: 'Sweep Tester' })
  })
  afterAll(cleanup)
  beforeEach(() => {
    vi.mocked(getCachedVinDecode).mockResolvedValue(undefined as never)
    vi.mocked(decodeVinRemote).mockResolvedValue({ decode: [], price: null, price_currency: null } as never)
    vi.mocked(normalizeVinDecode).mockReturnValue({
      manufacturer: 'Audi',
      model: 'A4',
      fuelType: 'diesel',
      enginePowerKw: 100,
    } as never)
    vi.mocked(translateTexts).mockImplementation(async (texts: string[]) => texts.map(t => `XX:${t}`))
  })

  it('decodes VIN into empty specs, translates the description, and marks ready', async () => {
    await itemRepo.createItem(
      {
        id: 'itest-sweep-a',
        title: 'A',
        categoryId: 'others',
        type: ItemType.ad,
        vin: 'WAUZZZ8K9BA123456',
        description: { cz: 'Popis vozu' },
      },
      UID,
    )
    expect((await stateOf('itest-sweep-a'))?.enrichmentStatus).toBe('pending') // stamped by createItem

    const res = await enrichListings()
    expect(res.claimed).toBeGreaterThanOrEqual(1)
    expect(res.vinFilled).toBeGreaterThanOrEqual(1)
    expect(res.translated).toBeGreaterThanOrEqual(1)

    const item = await itemRepo.getById('itest-sweep-a')
    expect(item?.specs?.manufacturer).toBe('Audi')
    expect(item?.fuelType).toBe('diesel')
    expect(item?.description?.cz).toBe('Popis vozu') // source preserved (not overwritten)
    expect(item?.description?.de).toBe('XX:Popis vozu') // empty locale filled
    expect((await stateOf('itest-sweep-a'))?.enrichmentStatus).toBe('ready')
  })

  it('marks failed and bumps attempts when a translation call throws', async () => {
    vi.mocked(translateTexts).mockRejectedValue(new Error('deepl down'))
    await itemRepo.createItem(
      { id: 'itest-sweep-b', title: 'B', categoryId: 'others', type: ItemType.ad, description: { cz: 'Popis' } },
      UID,
    )
    await enrichListings()
    const s = await stateOf('itest-sweep-b')
    expect(s?.enrichmentStatus).toBe('failed')
    expect(Number(s?.enrichmentAttempts)).toBeGreaterThanOrEqual(1)
  })

  it('never overwrites a hand-entered spec (only fills empties)', async () => {
    await itemRepo.createItem(
      {
        id: 'itest-sweep-c',
        title: 'C',
        categoryId: 'others',
        type: ItemType.ad,
        vin: 'WAUZZZ8K9BA999999',
        fuelType: 'petrol', // already set by hand → must NOT become 'diesel'
        description: { cz: 'x', de: 'x', en: 'x', fr: 'x', nl: 'x', pl: 'x', ru: 'x', ua: 'x' },
      },
      UID,
    )
    await enrichListings()
    const item = await itemRepo.getById('itest-sweep-c')
    expect(item?.fuelType).toBe('petrol') // preserved
    expect(item?.specs?.manufacturer).toBe('Audi') // the empty one got filled
  })
})
