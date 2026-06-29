import { describe, expect, it, vi } from 'vitest'
import { renderEmail } from '~/server/email/render'

vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn() }))

// The newsletter's MJML item-grid block is the fiddliest piece — assert it renders to HTML
// (no MJML errors thrown) and carries the item data + unsubscribe link, across scripts.
describe('newsletter email render', () => {
  const params = {
    recommendedItems: [
      {
        title: 'BMW X5',
        price: '500 000 Kč',
        endsAt: '01.07.2026 12:00',
        imageUrl: 'https://img/x5.jpg',
        url: 'http://t/item/a',
      },
      {
        title: 'Audi A6',
        price: '400 000 Kč',
        endsAt: '02.07.2026 12:00',
        imageUrl: 'https://img/a6.jpg',
        url: 'http://t/item/b',
      },
    ],
    unsubscribeUrl: 'http://t/api/newsletter/unsubscribe?token=u1.sig',
  }

  it.each(['cz', 'en', 'ar'])('renders %s with the items + unsubscribe link', async lang => {
    const out = await renderEmail('newsletter', lang, params)
    expect(out.subject.length).toBeGreaterThan(0)
    expect(out.html).toContain('BMW X5')
    expect(out.html).toContain('Audi A6')
    expect(out.html).toContain('http://t/item/a')
    expect(out.html).toContain('http://t/api/newsletter/unsubscribe?token=u1.sig')
    expect(out.text).toContain('BMW X5') // plaintext fallback present
  })

  it('leaves the existing templates unchanged (no items block when none given)', async () => {
    const out = await renderEmail('depositPaid', 'cz', {
      depositAmount: '10 000 Kč',
      billingUrl: 'http://t/profile/billing',
    })
    expect(out.html).not.toContain('newsletter')
    expect(out.html).toContain('10 000 Kč')
  })
})
