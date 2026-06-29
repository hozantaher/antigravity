import { describe, expect, it, vi } from 'vitest'
import useSettlement from '~/features/sale/sale-settlement/logic/useSettlement'

describe('useSettlement', () => {
  it('fetches status and derives the state flags, keeping the last value on error', async () => {
    const s = useSettlement('itemA')
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ state: 'pending', amountDue: { amount: 31500 } }))
    await s.fetchStatus()
    expect(s.status.value).toMatchObject({ state: 'pending' })
    expect(s.isPending.value).toBe(true)
    expect(s.isPaid.value).toBe(false)
    expect(s.isDue.value).toBe(false)

    // A transient poll failure must not flash the UI back.
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await s.fetchStatus()
    expect(s.status.value).toMatchObject({ state: 'pending' })
  })

  it('treats both paid and completed as paid (terminal for the wizard)', async () => {
    const s = useSettlement('itemPaid')
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ state: 'completed' }))
    await s.fetchStatus()
    expect(s.isPaid.value).toBe(true)
    expect(s.isCompleted.value).toBe(true)
  })

  it('POSTs to start a transfer and a checkout for the item', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ url: 'https://pay' })
    vi.stubGlobal('$fetch', fetchMock)
    const s = useSettlement('itemB')
    await s.startTransfer()
    expect(fetchMock).toHaveBeenCalledWith('/api/item/itemB/settlement/transfer', { method: 'POST' })
    await s.startCheckout()
    expect(fetchMock).toHaveBeenCalledWith('/api/item/itemB/settlement/checkout', { method: 'POST' })
  })

  it('shares state per item via a keyed useState (two instances, one source)', async () => {
    const a = useSettlement('shared1')
    const b = useSettlement('shared1')
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ state: 'paid' }))
    await a.fetchStatus()
    // b reads the same useState bucket.
    expect(b.status.value).toMatchObject({ state: 'paid' })
    expect(b.isPaid.value).toBe(true)
  })

  it('keys state by item id (different items are isolated)', async () => {
    const a = useSettlement('keyA')
    const b = useSettlement('keyB')
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ state: 'due' }))
    await a.fetchStatus()
    expect(a.status.value).toMatchObject({ state: 'due' })
    expect(b.status.value).toBeUndefined()
  })
})
