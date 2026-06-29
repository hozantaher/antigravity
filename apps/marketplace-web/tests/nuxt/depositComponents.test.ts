import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DepositStepper from '~/features/sale/deposit-billing/ui/deposit/DepositStepper.vue'
import DepositStepCurrency from '~/features/sale/deposit-billing/ui/deposit/DepositStepCurrency.vue'

// Component smoke tests — confidence only. Components are excluded from the coverage denominator.
describe('DepositStepper', () => {
  it('renders one segment per label and marks done/active steps', async () => {
    const w = await mountSuspended(DepositStepper, { props: { labels: ['One', 'Two', 'Three'], step: 1 } })
    expect(w.findAll('.segment')).toHaveLength(3)
    expect(w.text()).toContain('Two')
    // step 0 is done (check icon), step 1 is active.
    expect(w.findAll('.dot.is-done')).toHaveLength(1)
    expect(w.findAll('.dot.is-active')).toHaveLength(1)
  })
})

describe('DepositStepCurrency', () => {
  it('renders the CZK/EUR choices and emits the picked currency on continue', async () => {
    const w = await mountSuspended(DepositStepCurrency)
    const choices = w.findAll('.choice')
    expect(choices).toHaveLength(2)

    // Continue is disabled until a currency is chosen.
    expect(w.find('.continue-btn').attributes('disabled')).toBeDefined()

    await choices[0]!.trigger('click')
    await w.find('.continue-btn').trigger('click')
    expect(w.emitted('next')?.[0]).toEqual(['CZK'])
  })
})
