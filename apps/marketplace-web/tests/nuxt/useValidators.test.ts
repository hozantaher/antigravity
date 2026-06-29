import { describe, expect, it } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

import useValidators from '~/features/platform/design-system/logic/useValidators'

// useI18n() throws outside a component setup; stub it (it's a module composable, not core bootstrap).
mockNuxtImport('useI18n', () => () => ({ t: (key: string) => key }))

describe('useValidators', () => {
  it('validates min/max and lengths', () => {
    const v = useValidators()
    expect(v.minValidator(5).validator(10)).toBe(true)
    expect(v.minValidator(5).validator(3)).toBe(false)
    expect(v.maxValidator(5).validator(3)).toBe(true)
    expect(v.maxValidator(5).validator(10)).toBe(false)
    expect(v.minLengthValidator(3).validator('abcd')).toBe(true)
    expect(v.maxLengthValidator(3).validator('ab')).toBe(true)
  })

  it('validates email and phone shapes', () => {
    const v = useValidators()
    expect(!!v.emailValidator().validator('a@b.cz')).toBe(true)
    expect(!!v.emailValidator().validator('bad')).toBe(false)
    expect(!!v.phoneValidator().validator('+420 123 456')).toBe(true)
    expect(!!v.phoneValidator().validator('abc')).toBe(false)
  })

  it('exposes an i18n message on each validator', () => {
    const v = useValidators()
    expect(typeof v.minValidator(5).message).toBe('string')
  })
})
