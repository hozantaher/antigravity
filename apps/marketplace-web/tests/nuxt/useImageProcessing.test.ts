import { describe, expect, it } from 'vitest'
import { useImageProcessing } from '~/features/supply/media-upload/logic/useImageProcessing'

const opsOf = (url: string) => JSON.parse(new URL(url).searchParams.get('operations') ?? '[]')

// Mutate the real runtime config (mocking useRuntimeConfig breaks Nuxt's own bootstrap), then build.
const ip = () => {
  ;(useRuntimeConfig().public as Record<string, string>).imageProcessingUrl = 'https://img'
  return useImageProcessing()
}

describe('useImageProcessing', () => {
  it('builds a process URL with resize + output operations', () => {
    const url = ip().getImageUrl('https://cdn/p.jpg', { width: 100, height: 80 })
    expect(url.startsWith('https://img/process?operations=')).toBe(true)
    const ops = opsOf(url)
    expect(ops[0]).toMatchObject({ operation: 'input', url: 'https://cdn/p.jpg' })
    expect(ops).toContainEqual(expect.objectContaining({ operation: 'resize', width: 100, height: 80 }))
    expect(ops.at(-1)).toMatchObject({ operation: 'output', format: 'webp', quality: 85 })
  })

  it('passes through non-http sources and empty input untouched', () => {
    expect(ip().getImageUrl('relative.jpg')).toBe('relative.jpg')
    expect(ip().getImageUrl('')).toBe('')
    expect(ip().imgUrl('')).toBe('')
  })

  it('maps named sizes via imgUrl', () => {
    const ops = opsOf(ip().imgUrl('https://cdn/p.jpg', '500x370'))
    expect(ops).toContainEqual(expect.objectContaining({ operation: 'resize', width: 500, height: 370 }))
  })

  it('double-encodes Firebase storage paths', () => {
    const fb = 'https://firebasestorage.googleapis.com/v0/b/bucket/o/public%2Fads%2Fx.jpg?alt=media&token=t'
    const ops = opsOf(ip().getImageUrl(fb))
    expect(ops[0].url).toContain('%252F') // %2F → %252F
    expect(ops[0].url).toContain('alt=media')
  })

  it('exposes named size helpers', () => {
    const p = ip()
    for (const helper of [p.getSearchImage, p.getCardImage, p.getMediumImage, p.getLargeImage]) {
      expect(helper('https://cdn/p.jpg')).toContain('https://img/process?operations=')
    }
    expect(p.getSearchImage('')).toBe('')
  })

  it('emits DPR and width srcsets', () => {
    const dpr = ip().dprSrcset('https://cdn/p.jpg', '380x280')
    expect(dpr).toContain(' 1x,')
    expect(dpr).toContain(' 2x')
    const ws = ip().widthSrcset('https://cdn/p.jpg', [100, 200])
    expect(ws).toContain(' 100w')
    expect(ws).toContain(' 200w')
  })

  it('doubles dimensions for the 2x DPR candidate', () => {
    const dpr = ip().dprSrcset('https://cdn/p.jpg', '380x280')
    const [x1, x2] = dpr.split(', ')
    expect(opsOf(x1!.replace(/ 1x$/, ''))).toContainEqual(
      expect.objectContaining({ operation: 'resize', width: 380, height: 280 }),
    )
    expect(opsOf(x2!.replace(/ 2x$/, ''))).toContainEqual(
      expect.objectContaining({ operation: 'resize', width: 760, height: 560 }),
    )
  })

  it('emits width-only resize operations for widthSrcset', () => {
    const ws = ip().widthSrcset('https://cdn/p.jpg', [320])
    const ops = opsOf(ws.replace(/ 320w$/, ''))
    const resize = ops.find((op: { operation: string }) => op.operation === 'resize')
    expect(resize).toMatchObject({ operation: 'resize', width: 320 })
    expect(resize.height).toBeUndefined()
  })

  it('returns empty string for empty source in srcset helpers', () => {
    const p = ip()
    expect(p.dprSrcset('', '380x280')).toBe('')
    expect(p.widthSrcset('', [100, 200])).toBe('')
  })

  it('builds an empty width-descriptor srcset for an empty widths list', () => {
    expect(ip().widthSrcset('https://cdn/p.jpg', [])).toBe('')
  })

  it('imgUrl defaults to the 380x280 card size', () => {
    const ops = opsOf(ip().imgUrl('https://cdn/p.jpg'))
    expect(ops).toContainEqual(expect.objectContaining({ operation: 'resize', width: 380, height: 280 }))
  })

  it('passes sources through untouched when the endpoint is not configured', () => {
    ;(useRuntimeConfig().public as Record<string, string>).imageProcessingUrl = ''
    const p = useImageProcessing()
    const src = 'https://cdn/p.jpg'
    expect(p.getImageUrl(src, { width: 100 })).toBe(src)
    expect(p.imgUrl(src)).toBe(src)
    expect(p.dprSrcset(src, '380x280')).toBe(`${src} 1x, ${src} 2x`)
    expect(p.widthSrcset(src, [100])).toBe(`${src} 100w`)
  })
})
