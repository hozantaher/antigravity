import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '~/models'
import { makeEvent, setSessionUser } from '../../setup/server'
import handler from '~/server/api/item/[id]/bid.post'
import { placeBid } from '~/server/repos/itemRepo'

vi.mock('~/server/repos/itemRepo', () => ({ placeBid: vi.fn(), getTopBidderId: vi.fn() }))
vi.mock('~/server/utils/notify', () => ({ notifyOutbid: vi.fn() }))

const mockedPlaceBid = vi.mocked(placeBid)

// Real isUserEligibleToBid runs: hasDepositPaid && emailVerified && phone.
const eligible = (over: Partial<User> = {}): User =>
  ({ id: 'u1', depositRequired: false, emailVerified: true, phone: '+420123456789', ...over }) as User

beforeEach(() => {
  mockedPlaceBid.mockReset()
  setSessionUser(eligible())
})

describe('POST /api/item/[id]/bid', () => {
  it('places a bid for an eligible user', async () => {
    const item = { id: 'itm1', closed: false }
    mockedPlaceBid.mockResolvedValue(item as never)
    await expect(handler(makeEvent({ params: { id: 'itm1' }, body: { amount: 1100 } }))).resolves.toEqual(item)
    expect(mockedPlaceBid).toHaveBeenCalledWith('itm1', 'u1', 1100)
  })

  it('rejects an ineligible user with 403', async () => {
    setSessionUser(eligible({ emailVerified: false }))
    await expect(handler(makeEvent({ params: { id: 'itm1' }, body: { amount: 1100 } }))).rejects.toMatchObject({
      statusCode: 403,
    })
    expect(mockedPlaceBid).not.toHaveBeenCalled()
  })

  it('rejects a non-finite or non-positive amount with 400', async () => {
    await expect(handler(makeEvent({ params: { id: 'itm1' }, body: { amount: 'abc' } }))).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(handler(makeEvent({ params: { id: 'itm1' }, body: { amount: -5 } }))).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(mockedPlaceBid).not.toHaveBeenCalled()
  })

  it('maps a missing item to 404', async () => {
    mockedPlaceBid.mockResolvedValue(null as never)
    await expect(handler(makeEvent({ params: { id: 'nope' }, body: { amount: 5 } }))).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
