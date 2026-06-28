import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useKeyboardShortcuts } from '../../../src/hooks/useKeyboardShortcuts.js'

function Harness({ bindings, enabled }) {
  useKeyboardShortcuts(bindings, { enabled })
  return <div><input aria-label="in" /></div>
}

describe('useKeyboardShortcuts', () => {
  it('fires matching binding on plain key', () => {
    const handler = vi.fn()
    render(<Harness bindings={[{ key: '/', handler }]} />)
    fireEvent.keyDown(window, { key: '/' })
    expect(handler).toHaveBeenCalled()
  })

  it('matches mod: true on Ctrl and Meta', () => {
    const handler = vi.fn()
    render(<Harness bindings={[{ key: 'k', mod: true, handler }]} />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('skips bindings while typing unless allowInForm', () => {
    const handler = vi.fn()
    const escHandler = vi.fn()
    const { getByLabelText } = render(
      <Harness bindings={[
        { key: '/', handler },
        { key: 'Escape', handler: escHandler, allowInForm: true },
      ]} />
    )
    const input = getByLabelText('in')
    input.focus()
    fireEvent.keyDown(input, { key: '/' })
    expect(handler).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(escHandler).toHaveBeenCalled()
  })

  it('respects enabled=false', () => {
    const handler = vi.fn()
    render(<Harness bindings={[{ key: '/', handler }]} enabled={false} />)
    fireEvent.keyDown(window, { key: '/' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('checks when() predicate', () => {
    const handler = vi.fn()
    render(<Harness bindings={[{ key: '/', handler, when: () => false }]} />)
    fireEvent.keyDown(window, { key: '/' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('distinguishes shift modifier', () => {
    const plain = vi.fn()
    const shifted = vi.fn()
    render(<Harness bindings={[
      { key: '?', shift: true, handler: shifted },
      { key: '/', handler: plain },
    ]} />)
    fireEvent.keyDown(window, { key: '/' })
    fireEvent.keyDown(window, { key: '?', shiftKey: true })
    expect(plain).toHaveBeenCalledTimes(1)
    expect(shifted).toHaveBeenCalledTimes(1)
  })
})
