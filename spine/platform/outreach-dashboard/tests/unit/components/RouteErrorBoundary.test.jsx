import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
  ErrorBoundary: ({ children, fallback }) => {
    // Minimal ErrorBoundary simulation for unit testing
    return children
  },
}))

// RED: RouteErrorBoundary doesn't exist yet
const { RouteErrorBoundary } = await import('../../../src/components/RouteErrorBoundary.jsx')

function ThrowOnRender() {
  throw new Error('component crash')
}

describe('RouteErrorBoundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders children when no error', () => {
    render(
      <RouteErrorBoundary>
        <div>content</div>
      </RouteErrorBoundary>
    )
    expect(screen.getByText('content')).toBeDefined()
  })

  it('is a valid React component (not null)', () => {
    expect(RouteErrorBoundary).toBeTruthy()
    expect(typeof RouteErrorBoundary).toBe('function')
  })
})
