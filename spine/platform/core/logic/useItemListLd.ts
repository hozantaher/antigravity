import type { Item } from '~/models'

// ItemList JSON-LD for a listing page, in schema.org's "summary page" format (position + url only):
// it links the visible cards as an ordered list without re-stating each item's own Product markup,
// which lives on the item detail page. URLs are absolute and locale-default; a paginated page lists
// just its current slice. Emitting nothing for an empty list keeps unfinished SSR fetches clean.
export const useItemListLd = (items: MaybeRefOrGetter<Item[] | undefined>) => {
  const config = useRuntimeConfig()
  const requestUrl = useRequestURL()
  const origin = (config.public.baseUrl || requestUrl.origin).replace(/\/+$/, '')

  useHead(() => {
    const list = toValue(items) ?? []
    if (!list.length) return {}
    return {
      script: [
        {
          type: 'application/ld+json',
          innerHTML: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            itemListElement: list.map((it, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              url: `${origin}${itemPath(it)}`,
            })),
          }),
        },
      ],
    }
  })
}
