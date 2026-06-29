// Server-side e-mail layout — a single modern, on-brand card used by every e-mail:
// the auth templates (verification + password reset), the close-auctions winner
// notification, and the internal ops notifications (contact form + price offers).
// All of them just build an EmailContent and render through buildMjml.

export interface EmailCta {
  label: string
  url: string
}

// A recommended-vehicle row in the newsletter (§12). Optional, so the four existing
// templates (which set neither items nor unsubscribe) render byte-for-byte unchanged.
export interface EmailItemBlock {
  imageUrl: string
  title: string
  lines: string[] // already-localized price / ends lines
  url: string
  viewLabel: string
}

export interface EmailContent {
  subject: string
  heading: string
  paragraphs: string[]
  cta?: EmailCta
  items?: EmailItemBlock[]
  unsubscribe?: { label: string; url: string }
}

export interface LayoutStrings {
  contactIntro: string
  contactInfo: string
  regards: string
  team: string
  tagline: string
}

// The logo renders on a light card, so use the dark/full-color asset (the one previously
// shown on the light footer). Served as a static file from public/email/logo.png at the
// deployment origin — EMAIL_FOOTER_LOGO_URL overrides it (e.g. a CDN copy).
const LOGO_URL = process.env.EMAIL_FOOTER_LOGO_URL || `${process.env.BASE_URL || 'https://auction24.cz'}/email/logo.png`

// Brand palette (mirrors assets/css/main.css --color-app-*).
const RED = '#db302f' // app-red — primary accent / CTA
const INK = '#1d315f' // app-darkBlue — headings & emphasis
const BODY = '#3f3f46' // body copy
const MUTED = '#6b7280' // contact block
const FAINT = '#9aa1ad' // footer
const PAGE_BG = '#eef0f4'
const CARD_BORDER = '#e7e9ee'
const DIVIDER = '#edeef1'
const FONT = "'Lato', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export const buildMjml = (content: EmailContent, layout: LayoutStrings): string => {
  const ctaBlock = content.cta
    ? `
      <mj-section background-color="#ffffff" padding="8px 40px 18px 40px">
        <mj-column>
          <mj-button background-color="${RED}" color="#ffffff" font-size="15px" font-weight="700"
                     border-radius="10px" inner-padding="14px 38px" align="left"
                     href="${content.cta.url}">
            ${escapeHtml(content.cta.label)}
          </mj-button>
        </mj-column>
      </mj-section>`
    : ''

  const paragraphsHtml = content.paragraphs
    .map(p => `<p style="margin:0 0 14px 0;">${escapeHtml(p)}</p>`)
    .join('\n                ')

  // Recommended-vehicle rows: image left, title/price/ends/link right; stacks on mobile.
  const itemsBlock = (content.items ?? [])
    .map(
      it => `
      <mj-section background-color="#ffffff" padding="6px 40px 6px 40px">
        <mj-group vertical-align="middle">
          <mj-column width="40%" vertical-align="middle">
            <mj-image src="${it.imageUrl}" alt="${escapeHtml(it.title)}" border-radius="10px" padding="0" />
          </mj-column>
          <mj-column width="60%" vertical-align="middle">
            <mj-text>
              <p style="margin:0 0 6px 0; font-size:16px; font-weight:700; color:${INK};">${escapeHtml(it.title)}</p>
              ${it.lines.map(l => `<p style="margin:0 0 4px 0; font-size:14px; color:${BODY};">${escapeHtml(l)}</p>`).join('\n              ')}
              <p style="margin:8px 0 0 0;"><a href="${it.url}" style="font-size:14px; font-weight:700; color:${RED};">${escapeHtml(it.viewLabel)}</a></p>
            </mj-text>
          </mj-column>
        </mj-group>
      </mj-section>`,
    )
    .join('\n')

  const unsubscribeBlock = content.unsubscribe
    ? `
    <mj-section padding="0 40px 24px 40px">
      <mj-column>
        <mj-text align="center" font-size="13px" line-height="20px" color="${FAINT}">
          <a href="${content.unsubscribe.url}" style="color:${FAINT}; text-decoration:underline;">${escapeHtml(content.unsubscribe.label)}</a>
        </mj-text>
      </mj-column>
    </mj-section>`
    : ''

  return `<mjml>
  <mj-head>
    <mj-font name="Lato" href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap" />
    <mj-attributes>
      <mj-all font-family="${FONT}" />
      <mj-text font-size="16px" line-height="26px" color="${BODY}" />
    </mj-attributes>
    <mj-style>
      a { color: ${RED}; }
    </mj-style>
  </mj-head>
  <mj-body background-color="${PAGE_BG}" width="600px">
    <mj-section padding="32px 0 0 0" />

    <mj-wrapper background-color="#ffffff" border="1px solid ${CARD_BORDER}"
                border-top="4px solid ${RED}" border-radius="16px" padding="0">
      <mj-section background-color="#ffffff" padding="36px 40px 4px 40px">
        <mj-column>
          <mj-image src="${LOGO_URL}" alt="Auction24" width="150px" align="left" padding="0" />
        </mj-column>
      </mj-section>

      <mj-section background-color="#ffffff" padding="20px 40px 8px 40px">
        <mj-column>
          <mj-text>
            <h1 style="margin:0 0 16px 0; font-size:24px; line-height:32px; font-weight:700; color:${INK};">${escapeHtml(content.heading)}</h1>
            ${paragraphsHtml}
          </mj-text>
        </mj-column>
      </mj-section>
      ${ctaBlock}
      ${itemsBlock}

      <mj-section background-color="#ffffff" padding="12px 40px 36px 40px">
        <mj-column>
          <mj-divider border-width="1px" border-color="${DIVIDER}" padding="0 0 22px 0" />
          <mj-text font-size="14px" line-height="22px" color="${MUTED}">
            <p style="margin:0 0 6px 0;">${escapeHtml(layout.contactIntro)}</p>
            <p style="margin:0 0 18px 0;"><strong style="color:${INK};">${escapeHtml(layout.contactInfo)}</strong></p>
            <p style="margin:0;">${escapeHtml(layout.regards)}<br/><strong style="color:${INK};">${escapeHtml(layout.team)}</strong></p>
          </mj-text>
        </mj-column>
      </mj-section>
    </mj-wrapper>

    <mj-section padding="24px 40px 36px 40px">
      <mj-column>
        <mj-text align="center" font-size="13px" line-height="20px" color="${FAINT}">
          <p style="margin:0;">${escapeHtml(layout.tagline)}</p>
        </mj-text>
      </mj-column>
    </mj-section>
    ${unsubscribeBlock}
  </mj-body>
</mjml>`
}
