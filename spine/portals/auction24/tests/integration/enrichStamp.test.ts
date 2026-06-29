import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ItemType } from '~/models'
import { db } from '~/server/utils/db'
import * as userRepo from '~/server/repos/userRepo'
import * as itemRepo from '~/server/repos/itemRepo'

const RUN = !!process.env.POSTGRES_URL
const UID = 'itest-enrich-u1'

const cleanup = async () => {
  await db.deleteFrom('items').where('id', 'like', 'itest-enrich-%').execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-enrich-%').execute()
}

const statusOf = async (id: string): Promise<string | undefined> =>
  (await db.selectFrom('items').select('enrichmentStatus').where('id', '=', id).executeTakeFirst())?.enrichmentStatus

describe.skipIf(!RUN)('enrichment stamping (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await userRepo.createOrGetUser({ uid: UID, email: 'itest-enrich@example.test', name: 'Enrich Tester' })
  })
  afterAll(cleanup)

  it('stamps pending when a description has empty enrichable locales', async () => {
    await itemRepo.createItem(
      {
        id: 'itest-enrich-desc',
        title: 'Desc',
        categoryId: 'others',
        type: ItemType.ad,
        description: { cz: 'Popis vozu' },
      },
      UID,
    )
    expect(await statusOf('itest-enrich-desc')).toBe('pending')
  })

  it('stamps pending when a VIN is set but specs are empty', async () => {
    await itemRepo.createItem(
      { id: 'itest-enrich-vin', title: 'Vin', categoryId: 'others', type: ItemType.ad, vin: 'WAUZZZ8K9BA123456' },
      UID,
    )
    expect(await statusOf('itest-enrich-vin')).toBe('pending')
  })

  it('stays idle when there is no auto-fillable work', async () => {
    await itemRepo.createItem({ id: 'itest-enrich-idle', title: 'Idle', categoryId: 'others', type: ItemType.ad }, UID)
    expect(await statusOf('itest-enrich-idle')).toBe('idle')
  })
})
