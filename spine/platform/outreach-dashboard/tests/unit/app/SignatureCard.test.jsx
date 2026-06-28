/**
 * SignatureCard — signature contact card (#1581 M2.1).
 *   1. Renders company / IČO / email from the parsed signature.
 *   2. Shows the "známý klient" badge when crmMatch is present.
 *   3. Renders nothing when there is no signature or it carries no identity.
 */

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import SignatureCard from '../../../src/app/pages/SignatureCard'

describe('SignatureCard', () => {
  it('renders company, IČO and a mailto email', () => {
    render(<SignatureCard signature={{
      company: 'Zemědělská spol. s r.o.', ico: '47781173', email: 'zos@agrogast.cz', phones: [],
    }} />)
    expect(screen.getByTestId('app-sig-company')).toHaveTextContent('Zemědělská spol. s r.o.')
    expect(screen.getByTestId('app-sig-ico')).toHaveTextContent('47781173')
    expect(screen.getByTestId('app-sig-email')).toHaveAttribute('href', 'mailto:zos@agrogast.cz')
  })

  it('shows the známý klient badge when crmMatch is present', () => {
    render(<SignatureCard signature={{
      company: 'Firma s.r.o.', ico: '12345678', phones: [],
      crmMatch: { id: 9, name: 'Firma s.r.o.', crm_status: 'aktivní' },
    }} />)
    expect(screen.getByTestId('app-sig-crm')).toHaveTextContent('známý klient')
  })

  it('renders nothing when signature is null', () => {
    const { container } = render(<SignatureCard signature={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the signature carries no identity fields', () => {
    const { container } = render(<SignatureCard signature={{ salutation: 'S pozdravem', phones: [] }} />)
    expect(container.firstChild).toBeNull()
  })
})
