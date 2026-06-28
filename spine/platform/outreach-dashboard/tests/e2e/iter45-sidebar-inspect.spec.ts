import { test } from '@playwright/test'

test('sidebar dom inspection', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  const sidebarHtml = await page.evaluate(() => {
    const aside = document.querySelector('aside.sidebar')
    if (!aside) return 'NO SIDEBAR'
    // Walk children, print compact tree
    const lines: string[] = []
    function walk(el: Element, depth = 0) {
      const tag = el.tagName.toLowerCase()
      const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).join('.')}` : ''
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50)
      const rect = el.getBoundingClientRect()
      lines.push(`${'  '.repeat(depth)}${tag}${cls} [${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}] "${text}"`)
      if (depth < 4) {
        for (const child of Array.from(el.children)) walk(child, depth + 1)
      }
    }
    walk(aside)
    return lines.join('\n')
  })
  console.log('=== SIDEBAR DOM ===')
  console.log(sidebarHtml)

  const activeCss = await page.evaluate(() => {
    const el = document.querySelector('a.nav-item.active') as HTMLElement | null
    if (!el) return 'NO ACTIVE NAV'
    const cs = getComputedStyle(el)
    const span = el.querySelector('span') as HTMLElement | null
    const spanCs = span ? getComputedStyle(span) : null
    const svg = el.querySelector('svg') as SVGElement | null
    const svgCs = svg ? getComputedStyle(svg) : null
    return JSON.stringify({
      nav: {
        bg: cs.backgroundColor, color: cs.color, w: cs.width, h: cs.height, opacity: cs.opacity,
      },
      span: spanCs ? { color: spanCs.color, display: spanCs.display, visibility: spanCs.visibility, opacity: spanCs.opacity, w: spanCs.width } : null,
      svg: svgCs ? { color: svgCs.color, display: svgCs.display, visibility: svgCs.visibility, opacity: svgCs.opacity, w: svgCs.width } : null,
    }, null, 2)
  })
  console.log('=== ACTIVE NAV CSS ===')
  console.log(activeCss)

  const rootVars = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return {
      accent: cs.getPropertyValue('--accent'),
      accentSoft: cs.getPropertyValue('--accent-soft'),
      text: cs.getPropertyValue('--text'),
      surface: cs.getPropertyValue('--surface'),
      colorScheme: cs.colorScheme,
    }
  })
  console.log('=== ROOT VARS ===')
  console.log(JSON.stringify(rootVars, null, 2))
})
