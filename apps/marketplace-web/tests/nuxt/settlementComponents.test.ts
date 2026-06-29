import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SettlementStepper from '~/features/sale/sale-settlement/ui/settlement/SettlementStepper.vue'
import SettlementStepSummary from '~/features/sale/sale-settlement/ui/settlement/SettlementStepSummary.vue'
import SettlementStepMethod from '~/features/sale/sale-settlement/ui/settlement/SettlementStepMethod.vue'
import SettlementStepSuccess from '~/features/sale/sale-settlement/ui/settlement/SettlementStepSuccess.vue'
import type { Settlement } from '~/models'

// Component smoke tests — confidence only. Components are excluded from the coverage denominator.

const settlement = (over: Partial<Settlement> = {}): Settlement => ({
  itemId: 'i1',
  invoiceId: null,
  finalPrice: { amount: 32000, currency: { code: 'EUR' } as never },
  depositCredit: { amount: 500, currency: { code: 'EUR' } as never },
  amountDue: { amount: 31500, currency: { code: 'EUR' } as never },
  state: 'due',
  ...over,
})

describe('SettlementStepper', () => {
  it('renders one segment per label and marks done/active steps', async () => {
    const w = await mountSuspended(SettlementStepper, { props: { labels: ['One', 'Two', 'Three'], step: 1 } })
    expect(w.findAll('.segment')).toHaveLength(3)
    expect(w.findAll('.dot.is-done')).toHaveLength(1)
    expect(w.findAll('.dot.is-active')).toHaveLength(1)
  })
})

describe('SettlementStepSummary', () => {
  it('renders the price/credit/due lines and emits next on continue', async () => {
    const w = await mountSuspended(SettlementStepSummary, { props: { settlement: settlement() } })
    // final price + credit + due = 3 lines.
    expect(w.findAll('.sum-row')).toHaveLength(3)
    expect(w.find('.is-credit').exists()).toBe(true)
    await w.find('.next-btn').trigger('click')
    expect(w.emitted('next')).toBeTruthy()
  })

  it('hides the credit line when there is no deposit credit', async () => {
    const w = await mountSuspended(SettlementStepSummary, {
      props: { settlement: settlement({ depositCredit: { amount: 0, currency: { code: 'EUR' } as never } }) },
    })
    expect(w.find('.is-credit').exists()).toBe(false)
    expect(w.findAll('.sum-row')).toHaveLength(2)
  })

  it('shows the fully-covered note when amountDue is 0', async () => {
    const w = await mountSuspended(SettlementStepSummary, {
      props: { settlement: settlement({ amountDue: { amount: 0, currency: { code: 'EUR' } as never } }) },
    })
    expect(w.find('.covered-note').exists()).toBe(true)
  })
})

describe('SettlementStepMethod', () => {
  it('renders card/transfer choices and emits the picked method on continue', async () => {
    const w = await mountSuspended(SettlementStepMethod)
    const choices = w.findAll('.choice')
    expect(choices).toHaveLength(2)
    // Continue disabled until a method is chosen.
    expect(w.find('.next-btn').attributes('disabled')).toBeDefined()
    await choices[0]!.trigger('click')
    await w.find('.next-btn').trigger('click')
    expect(w.emitted('next')?.[0]).toEqual(['card'])
  })

  it('emits back', async () => {
    const w = await mountSuspended(SettlementStepMethod)
    await w.find('.back-btn').trigger('click')
    expect(w.emitted('back')).toBeTruthy()
  })
})

describe('SettlementStepSuccess', () => {
  it('renders the paid amount and emits close', async () => {
    const w = await mountSuspended(SettlementStepSuccess, { props: { amount: 31500, currency: 'EUR' } })
    expect(w.find('.paid-amount').exists()).toBe(true)
    await w.find('.close-btn').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })

  it('omits the amount for a deposit-covered (amount 0) completion', async () => {
    const w = await mountSuspended(SettlementStepSuccess, { props: { amount: 0, currency: 'EUR' } })
    expect(w.find('.paid-amount').exists()).toBe(false)
  })
})
