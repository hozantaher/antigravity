import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import { useSeo } from '~/features/platform/core/logic/useSeo'

// useSeoMeta cannot be mockNuxtImport'd (Nuxt's head plugin calls it during setupNuxt, which then
// hangs on the 10s hook). Instead we mount useSeo in a component, grab that mount's isolated head
// client via injectHead(), and resolve the tags it produced. Each mountSuspended spins up its own
// Nuxt app + head instance, so tags never bleed across tests.
type SeoOpts = Parameters<typeof useSeo>[0]

interface ResolvedHead {
  title: string | undefined
  meta: Record<string, string | undefined>
}

const readSeo = async (opts?: SeoOpts): Promise<ResolvedHead> => {
  let head: { resolveTags: () => Promise<Array<{ tag: string; textContent?: string; props: Record<string, string> }>> }
  const wrapper = await mountSuspended(
    defineComponent({
      setup() {
        useSeo(opts)
        head = injectHead() as unknown as typeof head
        return () => h('div')
      },
    }),
  )
  await flushPromises()

  const tags = await head!.resolveTags()
  const meta: Record<string, string | undefined> = {}
  let title: string | undefined
  for (const tag of tags) {
    if (tag.tag === 'title') title = tag.textContent
    if (tag.tag === 'meta') {
      const key = tag.props.property || tag.props.name
      if (key) meta[key] = tag.props.content
    }
  }

  // The Nuxt test app shares one head client across mounts; unmount so this component's
  // useSeoMeta entry is disposed and does not leak into the next test.
  wrapper.unmount()
  await flushPromises()
  return { title, meta }
}

describe('useSeo', () => {
  it('defaults all titles to the bare site name with no options', async () => {
    const { title, meta } = await readSeo()
    expect(title).toBe('Auction24.cz')
    expect(meta['og:title']).toBe('Auction24.cz')
    expect(meta['twitter:title']).toBe('Auction24.cz')
    expect(meta.description).toBeUndefined()
    expect(meta['og:image']).toBeUndefined()
    expect(meta.robots).toBeUndefined()
  })

  it('appends the suffix to a provided title', async () => {
    const { title, meta } = await readSeo({ title: 'My Page' })
    expect(title).toBe('My Page | Auction24.cz')
    expect(meta['og:title']).toBe('My Page')
    expect(meta['twitter:title']).toBe('My Page')
  })

  it('trims whitespace and falls back when the title is blank', async () => {
    const { title, meta } = await readSeo({ title: '   ' })
    expect(title).toBe('Auction24.cz')
    expect(meta['og:title']).toBe('Auction24.cz')
  })

  it('resolves a getter title and trims it', async () => {
    const { title, meta } = await readSeo({ title: () => '  Reactive  ' })
    expect(title).toBe('Reactive | Auction24.cz')
    expect(meta['og:title']).toBe('Reactive')
  })

  it('falls back when the title getter yields undefined', async () => {
    const { title, meta } = await readSeo({ title: () => undefined })
    expect(title).toBe('Auction24.cz')
    expect(meta['og:title']).toBe('Auction24.cz')
  })

  it('sets description keys when description is provided', async () => {
    const { meta } = await readSeo({ description: 'A description' })
    expect(meta.description).toBe('A description')
    expect(meta['og:description']).toBe('A description')
    expect(meta['twitter:description']).toBe('A description')
  })

  it('coerces an empty description to undefined', async () => {
    const { meta } = await readSeo({ description: '' })
    expect(meta.description).toBeUndefined()
    expect(meta['og:description']).toBeUndefined()
  })

  it('sets image keys when image is provided', async () => {
    const { meta } = await readSeo({ image: 'https://example.com/og.jpg' })
    expect(meta['og:image']).toBe('https://example.com/og.jpg')
    expect(meta['twitter:image']).toBe('https://example.com/og.jpg')
  })

  it('coerces an empty image to undefined', async () => {
    const { meta } = await readSeo({ image: '' })
    expect(meta['og:image']).toBeUndefined()
    expect(meta['twitter:image']).toBeUndefined()
  })

  it('sets robots when noindex is true', async () => {
    const { meta } = await readSeo({ noindex: true })
    expect(meta.robots).toBe('noindex, follow')
  })

  it('omits robots when noindex is false', async () => {
    const { meta } = await readSeo({ noindex: false })
    expect(meta.robots).toBeUndefined()
  })

  it('handles all options together', async () => {
    const { title, meta } = await readSeo({
      title: 'Full',
      description: 'Desc',
      image: 'img.png',
      noindex: true,
    })
    expect(title).toBe('Full | Auction24.cz')
    expect(meta.description).toBe('Desc')
    expect(meta['og:image']).toBe('img.png')
    expect(meta.robots).toBe('noindex, follow')
  })
})
