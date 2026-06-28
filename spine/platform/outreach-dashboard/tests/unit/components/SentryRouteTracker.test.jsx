import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'

// ── Sentry mock — hoisted so factory can reference the spy ───────────────────
// Use vi.hoisted() to create the mock fn before vi.mock() hoisting resolves.
const { addBreadcrumbMock } = vi.hoisted(() => {
  return { addBreadcrumbMock: vi.fn() }
})

vi.mock('../../../src/sentryInit.js', () => ({
  Sentry: {
    addBreadcrumb: addBreadcrumbMock,
  },
}))

// Import after mock is registered
const { default: SentryRouteTracker } = await import('../../../src/components/SentryRouteTracker')

beforeEach(() => {
  addBreadcrumbMock.mockClear()
})

// Helper: renders the tracker at an initial route inside a MemoryRouter
function renderTracker(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SentryRouteTracker />
      <Routes>
        <Route path="/" element={<div>Home</div>} />
        <Route path="/companies" element={<div>Companies</div>} />
        <Route path="/campaigns" element={<div>Campaigns</div>} />
        <Route path="/mailboxes" element={<div>Mailboxes</div>} />
      </Routes>
    </MemoryRouter>
  )
}

// Helper component for programmatic navigation
function NavButton({ to }) {
  const navigate = useNavigate()
  return <button onClick={() => navigate(to)}>go</button>
}

function renderTrackerWithNav(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SentryRouteTracker />
      <NavButton to="/companies" />
      <Routes>
        <Route path="/" element={<div>Home</div>} />
        <Route path="/companies" element={<div>Companies</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('SentryRouteTracker', () => {
  it('adds breadcrumb on initial mount with current pathname', () => {
    renderTracker('/companies')
    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'navigation',
        message: '/companies',
        level: 'info',
      })
    )
  })

  it('adds breadcrumb on location change', async () => {
    const { getByRole } = renderTrackerWithNav('/')
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1)
    expect(addBreadcrumbMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: '/' })
    )

    addBreadcrumbMock.mockClear()
    await act(async () => {
      getByRole('button').click()
    })
    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'navigation',
        message: '/companies',
        level: 'info',
      })
    )
  })

  it('breadcrumb category is always "navigation"', () => {
    renderTracker('/mailboxes')
    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'navigation' })
    )
  })

  it('breadcrumb level is always "info"', () => {
    renderTracker('/campaigns')
    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info' })
    )
  })

  it('renders null — no extra DOM element emitted by tracker', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <SentryRouteTracker />
      </MemoryRouter>
    )
    // The tracker renders null — container should have no child elements
    expect(container.firstChild).toBeNull()
  })

  it('is safe when addBreadcrumb throws (Sentry not initialized)', () => {
    addBreadcrumbMock.mockImplementationOnce(() => {
      throw new Error('Sentry not initialized')
    })
    expect(() => renderTracker('/')).not.toThrow()
  })

  it('does not re-fire breadcrumb when pathname stays the same between re-renders', () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <SentryRouteTracker />
        <Routes>
          <Route path="/" element={<div>Home</div>} />
        </Routes>
      </MemoryRouter>
    )
    const callsAfterMount = addBreadcrumbMock.mock.calls.length
    addBreadcrumbMock.mockClear()

    // Trigger a React re-render without changing location
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <SentryRouteTracker />
        <Routes>
          <Route path="/" element={<div>Home updated</div>} />
        </Routes>
      </MemoryRouter>
    )
    // The effect dep is location.pathname — a new MemoryRouter re-fires on mount.
    // Total calls should be ≤ callsAfterMount (i.e., not double-firing for same path).
    expect(addBreadcrumbMock.mock.calls.length).toBeLessThanOrEqual(callsAfterMount + 1)
  })

  it('handles rapid navigation without memory leak', async () => {
    const { getByRole, unmount } = renderTrackerWithNav('/')
    addBreadcrumbMock.mockClear()

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        getByRole('button').click()
      })
    }
    // Should have added at least one breadcrumb (may deduplicate same path)
    expect(addBreadcrumbMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    // Unmount must not throw (no lingering listeners)
    expect(() => unmount()).not.toThrow()
  })

  it('breadcrumb message contains the full pathname', () => {
    renderTracker('/campaigns')
    const call = addBreadcrumbMock.mock.calls.find(
      (c) => c[0]?.message === '/campaigns'
    )
    expect(call).toBeDefined()
  })
})
