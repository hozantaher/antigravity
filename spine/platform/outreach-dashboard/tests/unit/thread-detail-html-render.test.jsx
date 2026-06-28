/**
 * Sprint B3 — ThreadDetail HTML render + DOMPurify sanitization
 *
 * Tests that:
 * 1. The DOMPurify config strips all known XSS vectors from body_html.
 * 2. Safe HTML (plain text, links, bold) passes through intact.
 * 3. The OrphanBodyPanel conditional logic (body_html → sanitized HTML,
 *    body_preview fallback → pre-wrap text) is wired correctly.
 * 4. The MessageBubble conditional logic (msg.body_html → sanitized HTML,
 *    msg.body → plain text) is wired correctly.
 */

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import DOMPurify from 'isomorphic-dompurify'

// ── Replicate the exact config and hook from ThreadDetail.jsx ──────────────

const DOMPURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'a', 'strong', 'em', 'b', 'i', 'u',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
  ],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'title'],
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer nofollow')
  }
})

function sanitize(html) {
  return DOMPurify.sanitize(html, DOMPURIFY_CONFIG)
}

// ── Minimal OrphanBodyPanel mirroring the JSX in ThreadDetail ─────────────

function OrphanBodyPanel({ reply }) {
  if (!reply?.body_html && !reply?.body_preview) return null
  return (
    <div data-testid="orphan-panel">
      {reply.body_html
        ? (
          // dangerouslySetInnerHTML is safe here — always sanitized via DOMPurify (T-0310 annotated)
          <div
            data-testid="reply-body-preview"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: sanitize(reply.body_html) }}
          />
        ) : (
          <div
            data-testid="reply-body-preview"
            style={{ whiteSpace: 'pre-wrap' }}
          >
            {reply.body_preview}
          </div>
        )
      }
    </div>
  )
}

// ── Minimal MessageBubble mirroring the JSX in ThreadDetail ───────────────

function MessageBubble({ msg }) {
  return (
    <div data-testid="message-bubble">
      {msg.body_html
        ? (
          // dangerouslySetInnerHTML is safe here — always sanitized via DOMPurify (T-0310 annotated)
          <div
            data-testid="message-body"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: sanitize(msg.body_html) }}
          />
        ) : (
          <div data-testid="message-body" style={{ whiteSpace: 'pre-wrap' }}>
            {msg.body}
          </div>
        )
      }
    </div>
  )
}

// ── XSS payload stripping ─────────────────────────────────────────────────

describe('DOMPurify config — XSS payload stripping', () => {
  it('T-B3-01: strips <script> tag and its content', () => {
    const out = sanitize('<script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
  })

  it('T-B3-02: strips onerror attribute from <img>', () => {
    const out = sanitize('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('alert(1)')
  })

  it('T-B3-03: strips javascript: href from <a>', () => {
    const out = sanitize('<a href="javascript:alert(1)">link</a>')
    expect(out).not.toContain('javascript:')
  })

  it('T-B3-04: strips <iframe> entirely', () => {
    const out = sanitize('<iframe src="https://evil.com"></iframe>')
    expect(out).not.toContain('iframe')
    expect(out).not.toContain('evil.com')
  })

  it('T-B3-05: strips onload from <svg>', () => {
    const out = sanitize('<svg onload=alert(1)></svg>')
    expect(out).not.toContain('onload')
    expect(out).not.toContain('alert(1)')
  })

  it('T-B3-06: strips data: URI from <a> href', () => {
    const out = sanitize('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    expect(out).not.toContain('data:')
  })

  it('T-B3-07: strips <object> tag', () => {
    const out = sanitize('<object data="https://evil.com/xss.swf"></object>')
    expect(out).not.toContain('object')
    expect(out).not.toContain('evil.com')
  })
})

// ── Safe HTML passthrough ─────────────────────────────────────────────────

describe('DOMPurify config — safe HTML passthrough', () => {
  it('T-B3-08: preserves <p> with plain text', () => {
    const out = sanitize('<p>Dobrý den</p>')
    expect(out).toContain('Dobrý den')
    expect(out).toContain('<p>')
  })

  it('T-B3-09: preserves <strong> and <em>', () => {
    const out = sanitize('<p><strong>tučné</strong> a <em>kurzíva</em></p>')
    expect(out).toContain('<strong>tučné</strong>')
    expect(out).toContain('<em>kurzíva</em>')
  })

  it('T-B3-10: normalises <a> to target=_blank + rel=noopener noreferrer nofollow', () => {
    const out = sanitize('<a href="https://example.com">odkaz</a>')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
    expect(out).toContain('odkaz')
  })

  it('T-B3-11: preserves <ul>/<li> list', () => {
    const out = sanitize('<ul><li>Jedna</li><li>Dvě</li></ul>')
    expect(out).toContain('<ul>')
    expect(out).toContain('<li>Jedna</li>')
  })

  it('T-B3-12: preserves <blockquote> for reply quoting', () => {
    const out = sanitize('<blockquote>Původní zpráva</blockquote>')
    expect(out).toContain('<blockquote>')
    expect(out).toContain('Původní zpráva')
  })
})

// ── OrphanBodyPanel rendering ─────────────────────────────────────────────

describe('OrphanBodyPanel conditional HTML render', () => {
  it('T-B3-13: renders sanitized HTML when body_html present', () => {
    render(<OrphanBodyPanel reply={{ body_html: '<p>Dobrý den</p>', body_preview: 'fallback' }} />)
    const el = screen.getByTestId('reply-body-preview')
    expect(el.innerHTML).toContain('Dobrý den')
    // Should not render raw "fallback" as text content via pre-wrap
    expect(el.textContent).not.toBe('fallback')
  })

  it('T-B3-14: falls back to body_preview when body_html is absent', () => {
    render(<OrphanBodyPanel reply={{ body_preview: 'Zájem o nabídku' }} />)
    const el = screen.getByTestId('reply-body-preview')
    expect(el.textContent).toBe('Zájem o nabídku')
    // plain text fallback — no dangerouslySetInnerHTML
    expect(el.innerHTML).toBe('Zájem o nabídku')
  })

  it('T-B3-15: strips XSS from body_html in OrphanBodyPanel', () => {
    const xssPayload = '<script>alert(1)</script><p>safe</p><img src=x onerror=alert(2)>'
    render(<OrphanBodyPanel reply={{ body_html: xssPayload }} />)
    const el = screen.getByTestId('reply-body-preview')
    expect(el.innerHTML).not.toContain('<script')
    expect(el.innerHTML).not.toContain('onerror')
    expect(el.innerHTML).not.toContain('alert(')
    expect(el.textContent).toContain('safe')
  })

  it('T-B3-16: renders nothing when both body_html and body_preview are absent', () => {
    render(<OrphanBodyPanel reply={{}} />)
    expect(screen.queryByTestId('orphan-panel')).toBeNull()
  })
})

// ── MessageBubble rendering ───────────────────────────────────────────────

describe('MessageBubble conditional HTML render', () => {
  it('T-B3-17: renders sanitized HTML when body_html present on msg', () => {
    render(<MessageBubble msg={{ body_html: '<p>Nabídka přijata</p>', body: 'fallback plain' }} />)
    const el = screen.getByTestId('message-body')
    expect(el.innerHTML).toContain('Nabídka přijata')
  })

  it('T-B3-18: falls back to msg.body when body_html absent', () => {
    render(<MessageBubble msg={{ body: 'Dobrý den, prosím o info.' }} />)
    const el = screen.getByTestId('message-body')
    expect(el.textContent).toBe('Dobrý den, prosím o info.')
  })

  it('T-B3-19: strips <iframe> from msg.body_html in MessageBubble', () => {
    render(<MessageBubble msg={{ body_html: '<iframe src="https://evil.com"></iframe><p>ok</p>' }} />)
    const el = screen.getByTestId('message-body')
    expect(el.innerHTML).not.toContain('iframe')
    expect(el.innerHTML).not.toContain('evil.com')
    expect(el.textContent).toContain('ok')
  })

  it('T-B3-20: <a> in msg.body_html gets noopener enforcement', () => {
    render(<MessageBubble msg={{ body_html: '<a href="https://garaaage.cz">web</a>' }} />)
    const link = screen.getByTestId('message-body').querySelector('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('rel')).toContain('nofollow')
  })
})
