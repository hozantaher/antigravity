// Per-page SEO: sets the document <title> (with the " | Auction24.cz" suffix) plus the
// matching Open Graph / Twitter title, and — when given — description and image. app.vue owns
// the site-wide defaults (canonical, og:site_name/type/url/locale, default image, Organization
// JSON-LD); this only overrides what a page knows. Keys are set conditionally so a page that
// omits description/image keeps the app-level default instead of blanking it out.
interface SeoOptions {
  title?: MaybeRefOrGetter<string | undefined>
  description?: MaybeRefOrGetter<string | undefined>
  image?: MaybeRefOrGetter<string | undefined>
  noindex?: boolean
}

export const useSeo = (opts: SeoOptions = {}) => {
  const clean = () => toValue(opts.title)?.trim() || undefined

  const input: Parameters<typeof useSeoMeta>[0] = {
    title: () => (clean() ? `${clean()} | Auction24.cz` : 'Auction24.cz'),
    ogTitle: () => clean() || 'Auction24.cz',
    twitterTitle: () => clean() || 'Auction24.cz',
  }

  if (opts.description !== undefined) {
    const desc = () => toValue(opts.description) || undefined
    input.description = desc
    input.ogDescription = desc
    input.twitterDescription = desc
  }

  if (opts.image !== undefined) {
    const img = () => toValue(opts.image) || undefined
    input.ogImage = img
    input.twitterImage = img
  }

  if (opts.noindex) input.robots = 'noindex, follow'

  useSeoMeta(input)
}
