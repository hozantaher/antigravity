import { describe, expect, it, vi } from 'vitest'
import useDeposit from '~/features/sale/deposit-billing/logic/useDeposit'

describe('useDeposit', () => {
  it('fetches status and derives isPaid, keeping the last value on error', async () => {
    const d = useDeposit()
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ state: 'paid' }))
    await d.fetchStatus()
    expect(d.status.value).toEqual({ state: 'paid' })
    expect(d.isPaid.value).toBe(true)
    expect(d.isPending.value).toBe(false)

    // A transient poll failure must not flash the UI back to "none".
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await d.fetchStatus()
    expect(d.status.value).toEqual({ state: 'paid' })
  })

  it('POSTs to start a transfer and a checkout', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ url: 'https://pay' })
    vi.stubGlobal('$fetch', fetchMock)
    const d = useDeposit()
    await d.startTransfer('CZK')
    expect(fetchMock).toHaveBeenCalledWith('/api/deposit/transfer', { method: 'POST', body: { currency: 'CZK' } })
    await d.startCheckout('EUR')
    expect(fetchMock).toHaveBeenCalledWith('/api/deposit/checkout', { method: 'POST', body: { currency: 'EUR' } })
  })
})
