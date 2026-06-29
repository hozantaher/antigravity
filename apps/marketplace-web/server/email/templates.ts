import type { EmailItemCard } from '~/models'
import type { EmailContent } from './layout'

// Two auth e-mails, the close-auctions winner notification, the deposit-paid
// confirmation and the recommendations newsletter are wired in garaaage-auction
// (the rest of garaaage-main's transactional set isn't ported).
export type EmailTemplateKey =
  | 'sendVerificationEmail'
  | 'resetPassword'
  | 'auctionWon'
  | 'depositPaid'
  | 'salePaid'
  | 'newsletter'
  | 'savedSearchAlert'

export interface TemplateStrings {
  sendVerificationEmail: { subject: string; heading: string; body1: string; cta: string }
  resetPassword: { subject: string; heading: string; body1: string; body2: string; cta: string }
  // {item} / {amount} placeholders are interpolated from EmailParams.
  auctionWon: { subject: string; heading: string; body1: string; body2: string; cta: string }
  // {amount} placeholder is interpolated from EmailParams.
  depositPaid: { subject: string; heading: string; body1: string; body2: string; cta: string }
  // Sale-paid receipt. {item} / {amount} placeholders are interpolated from EmailParams.
  salePaid: { subject: string; heading: string; body1: string; body2: string; cta: string }
  // Recommended-vehicles newsletter (§12). Item rows come from EmailParams.recommendedItems.
  newsletter: {
    subject: string
    heading: string
    intro: string
    endsLabel: string
    viewLabel: string
    unsubscribe: string
  }
  // Saved-search alert: new matches for a user's saved search. {name} (the saved-search name) is
  // interpolated into subject/heading/intro. Item rows come from EmailParams.recommendedItems.
  savedSearchAlert: {
    subject: string
    heading: string
    intro: string
    endsLabel: string
    viewLabel: string
    unsubscribe: string
  }
}

export interface EmailParams {
  verificationUrl?: string
  resetUrl?: string
  itemTitle?: string
  itemUrl?: string
  winningAmount?: string
  depositAmount?: string
  saleAmount?: string
  billingUrl?: string
  recommendedItems?: EmailItemCard[]
  unsubscribeUrl?: string
  savedSearchName?: string
}

const fill = (s: string, vars: Record<string, string>): string =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '')

type Builder<K extends EmailTemplateKey> = (s: TemplateStrings[K], p: EmailParams) => EmailContent

const sendVerificationEmail: Builder<'sendVerificationEmail'> = (s, p) => ({
  subject: s.subject,
  heading: s.heading,
  paragraphs: [s.body1],
  cta: { label: s.cta, url: p.verificationUrl ?? '#' },
})

const resetPassword: Builder<'resetPassword'> = (s, p) => ({
  subject: s.subject,
  heading: s.heading,
  paragraphs: [s.body1, s.body2],
  cta: { label: s.cta, url: p.resetUrl ?? '#' },
})

const auctionWon: Builder<'auctionWon'> = (s, p) => {
  const vars = { item: p.itemTitle ?? '', amount: p.winningAmount ?? '' }
  return {
    subject: fill(s.subject, vars),
    heading: fill(s.heading, vars),
    paragraphs: [fill(s.body1, vars), fill(s.body2, vars)],
    cta: { label: s.cta, url: p.itemUrl ?? '#' },
  }
}

const depositPaid: Builder<'depositPaid'> = (s, p) => {
  const vars = { amount: p.depositAmount ?? '' }
  return {
    subject: fill(s.subject, vars),
    heading: fill(s.heading, vars),
    paragraphs: [fill(s.body1, vars), fill(s.body2, vars)],
    cta: { label: s.cta, url: p.billingUrl ?? '#' },
  }
}

const salePaid: Builder<'salePaid'> = (s, p) => {
  const vars = { item: p.itemTitle ?? '', amount: p.saleAmount ?? '' }
  return {
    subject: fill(s.subject, vars),
    heading: fill(s.heading, vars),
    paragraphs: [fill(s.body1, vars), fill(s.body2, vars)],
    cta: { label: s.cta, url: p.itemUrl ?? '#' },
  }
}

const newsletter: Builder<'newsletter'> = (s, p) => ({
  subject: s.subject,
  heading: s.heading,
  paragraphs: [s.intro],
  items: (p.recommendedItems ?? []).map(it => ({
    imageUrl: it.imageUrl,
    title: it.title,
    lines: [it.price, it.endsAt ? `${s.endsLabel} ${it.endsAt}` : undefined].filter((l): l is string => !!l),
    url: it.url,
    viewLabel: s.viewLabel,
  })),
  unsubscribe: p.unsubscribeUrl ? { label: s.unsubscribe, url: p.unsubscribeUrl } : undefined,
})

const savedSearchAlert: Builder<'savedSearchAlert'> = (s, p) => {
  const vars = { name: p.savedSearchName ?? '' }
  return {
    subject: fill(s.subject, vars),
    heading: fill(s.heading, vars),
    paragraphs: [fill(s.intro, vars)],
    items: (p.recommendedItems ?? []).map(it => ({
      imageUrl: it.imageUrl,
      title: it.title,
      lines: [it.price, it.endsAt ? `${s.endsLabel} ${it.endsAt}` : undefined].filter((l): l is string => !!l),
      url: it.url,
      viewLabel: s.viewLabel,
    })),
    unsubscribe: p.unsubscribeUrl ? { label: s.unsubscribe, url: p.unsubscribeUrl } : undefined,
  }
}

export const TEMPLATE_BUILDERS: { [K in EmailTemplateKey]: Builder<K> } = {
  sendVerificationEmail,
  resetPassword,
  auctionWon,
  depositPaid,
  salePaid,
  newsletter,
  savedSearchAlert,
}
