import { describe, it, expect } from 'vitest'
import { renderEmail } from '~/server/email/render'

describe('depositPaid e-mail', () => {
  it('interpolates the amount and localizes (cz)', async () => {
    const { subject, html, text } = await renderEmail('depositPaid', 'cz', {
      depositAmount: '10 000 Kč',
      billingUrl: 'https://auction24.cz/profile/billing',
    })
    expect(subject).toBe('Vaše kauce byla přijata')
    expect(text).toContain('Vaši kauci ve výši 10 000 Kč')
    expect(html).toContain('https://auction24.cz/profile/billing')
  })

  it('renders in the recipient language (en)', async () => {
    const { subject, text } = await renderEmail('depositPaid', 'en', { depositAmount: '€500' })
    expect(subject).toBe('Your deposit has been received')
    expect(text).toContain('€500')
  })

  it('falls back to English for an unknown locale', async () => {
    const { subject } = await renderEmail('depositPaid', 'xx', { depositAmount: '€500' })
    expect(subject).toBe('Your deposit has been received')
  })

  it('uses the served /email/logo.png asset, not the old 404 URL', async () => {
    const { html } = await renderEmail('depositPaid', 'en', { depositAmount: '€500' })
    expect(html).toContain('/email/logo.png')
    expect(html).not.toContain('footer-logo.png')
  })
})
