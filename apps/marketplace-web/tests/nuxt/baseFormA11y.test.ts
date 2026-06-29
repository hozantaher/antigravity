import { describe, it, expect } from 'vitest'
import { h } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import BaseForm from '~/features/platform/design-system/ui/BaseForm.vue'

expect.extend(axeMatchers)

// vitest-axe ^0.1.0's bundled type augmentation doesn't merge with this vitest's
// Assertion<T>, so the one matcher we use is declared here explicitly.
declare module 'vitest' {
  interface Assertion<T = any> {
    toHaveNoViolations(): void
  }
}

// Proving test for vektor DoD `test:a11y` — BaseForm must be a semantic, keyboard-operable form,
// not the old non-semantic <div @click>. Layout-only axe rules (color-contrast, region) can't be
// evaluated in happy-dom, so they're disabled; the structural/role rules that matter here run.
const AXE_OPTS = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }

const accessibleSlots = {
  // implicit label association (input inside <label>) → no unlabeled-control violation
  default: () => h('label', {}, ['Name', h('input', { type: 'text', name: 'name' })]),
  button: () => h('button', { type: 'submit' }, 'Submit'),
}

describe('BaseForm a11y', () => {
  it('renders a real <form> with a submit <button> (no <div @click>)', async () => {
    const w = await mountSuspended(BaseForm, { slots: accessibleSlots })
    expect(w.find('form').exists()).toBe(true)
    expect(w.find('button[type="submit"]').exists()).toBe(true)
  })

  it('has no axe violations', async () => {
    const w = await mountSuspended(BaseForm, { slots: accessibleSlots })
    const results = await axe(w.element, AXE_OPTS)
    expect(results).toHaveNoViolations()
  })

  it('emits onSubmit via native form submission (keyboard-operable)', async () => {
    const w = await mountSuspended(BaseForm, { slots: accessibleSlots })
    await w.find('form').trigger('submit')
    expect(w.emitted('onSubmit')).toBeTruthy()
  })
})
