import { describe, expect, it } from 'vitest'
import { ModalSize } from '~/models'

describe('ModalSize', () => {
  it('maps each size to its pixel width', () => {
    expect(ModalSize.Small).toBe('400px')
    expect(ModalSize.Wizard).toBe('520px')
    expect(ModalSize.Medium).toBe('720px')
    expect(ModalSize.Large).toBe('920px')
  })

  it('exposes exactly the four documented sizes', () => {
    expect(Object.keys(ModalSize)).toEqual(['Small', 'Wizard', 'Medium', 'Large'])
  })
})
