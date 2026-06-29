import type { EmailContent } from './layout'
import { renderContent, type RenderedEmail } from './render'
import { getTranslation } from './translations'

// Internal ops notifications (contact form + price offers). Unlike the user-facing
// transactional e-mails these aren't localized per recipient — they go to staff, so they
// render in one fixed language (the company locale) and bypass the per-locale template registry.
const OPS_LOCALE = 'cz'

export interface ContactNotification {
  kind: 'contact' | 'offer' | 'question'
  name?: string
  email?: string
  phone?: string
  location?: string
  vehicle?: string
  message?: string
  itemTitle?: string
  itemUrl?: string
  offerAmount?: string
}

const DASH = '—'

const contactContent = (n: ContactNotification): EmailContent => ({
  subject: `Nová zpráva z kontaktního formuláře${n.name ? ` — ${n.name}` : ''}`,
  heading: 'Nová kontaktní zpráva',
  paragraphs: [
    `Jméno: ${n.name ?? DASH}`,
    `E-mail: ${n.email ?? DASH}`,
    `Telefon: ${n.phone ?? DASH}`,
    `Lokalita vozidla: ${n.location ?? DASH}`,
    `Vozidlo k prodeji: ${n.vehicle ?? DASH}`,
    `Zpráva: ${n.message ?? DASH}`,
  ],
})

const offerContent = (n: ContactNotification): EmailContent => ({
  subject: `Nová cenová nabídka${n.itemTitle ? ` — ${n.itemTitle}` : ''}`,
  heading: 'Nová cenová nabídka',
  paragraphs: [
    `Vozidlo: ${n.itemTitle ?? n.itemUrl ?? DASH}`,
    `Nabízená cena: ${n.offerAmount ?? DASH}`,
    `Zájemce: ${n.name ?? DASH}`,
    `E-mail: ${n.email ?? DASH}`,
    `Telefon: ${n.phone ?? DASH}`,
  ],
  ...(n.itemUrl ? { cta: { label: 'Zobrazit inzerát', url: n.itemUrl } } : {}),
})

// A listing question: a question has no name/e-mail/phone (the asker is a signed-in user, kept
// private), so render just the question text + a link to the listing — no empty dash-rows.
const questionContent = (n: ContactNotification): EmailContent => ({
  subject: `Nový dotaz k inzerátu${n.itemTitle ? ` — ${n.itemTitle}` : ''}`,
  heading: 'Nový dotaz k inzerátu',
  paragraphs: [`Vozidlo: ${n.itemTitle ?? n.itemUrl ?? DASH}`, `Dotaz: ${n.message ?? DASH}`],
  ...(n.itemUrl ? { cta: { label: 'Zobrazit inzerát', url: n.itemUrl } } : {}),
})

const contentFor = (n: ContactNotification): EmailContent =>
  n.kind === 'offer' ? offerContent(n) : n.kind === 'question' ? questionContent(n) : contactContent(n)

// Builds the branded MJML/text for an ops notification. Free-text fields are escaped by
// buildMjml, so a sender can't inject markup into the e-mail.
export const buildContactNotification = (n: ContactNotification): Promise<RenderedEmail> =>
  renderContent(contentFor(n), getTranslation(OPS_LOCALE).layout, `contact:${n.kind}`)
