import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { ToastProvider, useToast } from '../../../src/components/Toast.jsx'

function Trigger({ msg, type, opts }) {
  const toast = useToast()
  return <button onClick={() => toast(msg, type, opts)}>fire</button>
}

describe('Toast', () => {
  it('shows plain toast', async () => {
    const user = userEvent.setup()
    render(<ToastProvider><Trigger msg="Uloženo" /></ToastProvider>)
    await user.click(screen.getByText('fire'))
    expect(screen.getByText('Uloženo')).toBeInTheDocument()
  })

  it('renders action button and invokes callback on click', async () => {
    const onUndo = vi.fn()
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <Trigger msg="Filtry zrušeny" type="info" opts={{ action: { label: 'Vrátit', onClick: onUndo } }} />
      </ToastProvider>
    )
    await user.click(screen.getByText('fire'))
    const undoBtn = screen.getByRole('button', { name: 'Vrátit' })
    await user.click(undoBtn)
    expect(onUndo).toHaveBeenCalledTimes(1)
    // Toast should dismiss after action click
    expect(screen.queryByText('Filtry zrušeny')).not.toBeInTheDocument()
  })

  it('close button dismisses without running action', async () => {
    const onUndo = vi.fn()
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <Trigger msg="Filtry zrušeny" type="info" opts={{ action: { label: 'Vrátit', onClick: onUndo } }} />
      </ToastProvider>
    )
    await user.click(screen.getByText('fire'))
    await user.click(screen.getByRole('button', { name: 'Zavřít' }))
    expect(onUndo).not.toHaveBeenCalled()
    expect(screen.queryByText('Filtry zrušeny')).not.toBeInTheDocument()
  })
})
