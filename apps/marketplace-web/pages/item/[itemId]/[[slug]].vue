<script lang="ts" setup>
const props = defineProps<{ itemId: string; slug?: string }>()

const { locale, t, te } = useI18n()
const config = useRuntimeConfig()
const requestUrl = useRequestURL()
const localePath = useLocalePath()
const origin = (config.public.baseUrl || requestUrl.origin).replace(/\/+$/, '')
const { findCategory } = useCategories()

// load=true: this page drives the SSR fetch; child components read the shared state.
const { item, ready } = useItemDetail(true)
useDetailTracking(item) // detail_view / dwell / scroll / bounce (no-op until consent)
const { user, isAdmin } = useUser()
const favoriteStore = useFavorites()

// SSR is anonymous; isAdmin only resolves client-side, so gate the admin-only link on mounted
// to avoid a hydration mismatch (server renders nothing, client adds it after auth resolves).
const mounted = useMounted()

// Localized, HTML-stripped, length-capped text for <meta description> + JSON-LD. The stored
// value is localized and may carry markup; a cookie-less crawler indexes the default locale.
const metaDescription = computed(() => {
  const d = item.value?.description
  if (!d) return undefined
  const raw = d[contentLocaleKey(locale.value)] || d.cz || d.en || Object.values(d)[0] || ''
  return (
    raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200) || undefined
  )
})

// og/twitter image sized to 1200×630 (raw uploads are full-res and the wrong ratio for social cards).
const { getOgImage } = useImageProcessing()
useSeo({
  title: () => item.value?.title,
  description: () => metaDescription.value,
  image: () => (item.value?.image ? getOgImage(item.value.image) : undefined),
})

// Product + Vehicle/Car structured data → eligible for rich results (price + availability, plus
// vehicle attributes for cars), with a BreadcrumbList for the Home → Category → item trail.
useHead(() => {
  const it = item.value
  if (!it) return {}
  const url = `${origin}${itemPath(it)}`
  const price = itemCurrentPrice(it)
  const status = itemStatus(it)
  const availability =
    status === ItemStatus.Sold || status === ItemStatus.AuctionEnd || status === ItemStatus.AuctionProcessing
      ? 'https://schema.org/SoldOut'
      : 'https://schema.org/InStock'
  const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
  // An auction's price only holds until it closes; a fixed-price ad's Offer still needs a future
  // priceValidUntil (Google warns without one), so roll it a year past the last update.
  const priceValidUntil =
    it.type === ItemType.auction && it.endDate
      ? isoDate(it.endDate)
      : isoDate((it.updated ?? it.created ?? it.endDate ?? Date.now()) + 365 * 24 * 60 * 60 * 1000)
  const offers =
    price?.amount != null && price.currency?.code
      ? {
          '@type': 'Offer',
          price: price.amount,
          priceCurrency: price.currency.code,
          availability,
          // Auction + resale marketplace: every listing is a used vehicle/machine.
          itemCondition: 'https://schema.org/UsedCondition',
          priceValidUntil,
          url,
        }
      : undefined
  const vehicle = buildVehicleLd(it)
  const category = findCategory(it.categoryId)
  const crumbs = [
    { '@type': 'ListItem', position: 1, name: t('seo.home'), item: `${origin}/` },
    ...(category
      ? [
          {
            '@type': 'ListItem',
            position: 2,
            name: t(`${category.id}Category`),
            item: `${origin}/category/${category.id}`,
          },
        ]
      : []),
    { '@type': 'ListItem', position: category ? 3 : 2, name: it.title, item: url },
  ]
  return {
    script: [
      {
        type: 'application/ld+json',
        innerHTML: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': vehicle ? ['Product', vehicle.vehicleType] : 'Product',
          name: it.title,
          image: it.images?.length ? it.images : it.image ? [it.image] : undefined,
          ...(metaDescription.value ? { description: metaDescription.value } : {}),
          ...(it.specs?.manufacturer ? { brand: { '@type': 'Brand', name: it.specs.manufacturer } } : {}),
          ...(it.vin ? { sku: it.vin } : {}),
          ...(vehicle ? vehicle.properties : {}),
          ...(offers ? { offers } : {}),
        }),
      },
      {
        type: 'application/ld+json',
        innerHTML: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: crumbs,
        }),
      },
    ],
  }
})

// Highlight titles are either legacy i18n param codes (cpBrand…) or already-localized
// strings; resolveHighlightLabel translates the former, passes the latter through. Blank
// drafts are dropped in selectPublicHighlights. cp* keys live in the i18n locale files.
const highlights = computed(() =>
  selectPublicHighlights(item.value?.highlights, contentLocaleKey(locale.value)).map(h => ({
    ...h,
    label: resolveHighlightLabel(h.title, { has: (k: string) => te(k), translate: (k: string) => t(k) }),
  })),
)

// Visible breadcrumb (Home → Category → item); mirrors the BreadcrumbList JSON-LD trail above.
const breadcrumbs = computed<{ label: string; to?: string }[]>(() => {
  const it = item.value
  if (!it) return []
  const category = findCategory(it.categoryId)
  return [
    { label: t('seo.home'), to: '/' },
    ...(category ? [{ label: t(`${category.id}Category`), to: `/category/${category.id}` }] : []),
    { label: it.title },
  ]
})

// A missing item must be a real 404 (SSR + client nav), not the skeleton at HTTP 200. Placed
// after the lifecycle-registering composables above so the await doesn't strip the active
// component instance.
if (ready) {
  await ready
  if (!item.value) throw createError({ statusCode: 404, statusMessage: 'Item not found', fatal: true })
  // Canonicalize the URL: a bare /item/<id> or a stale slug 301s to /item/<id>/<slug>. The id segment
  // resolves the page (AutoLine and the API are unaffected — this is the page route, not /api/item).
  const canonical = itemPath(item.value)
  const current = `/item/${item.value.id}${props.slug ? `/${props.slug}` : ''}`
  if (current !== canonical) await navigateTo(localePath(canonical), { redirectCode: 301 })
}
</script>

<template>
  <section v-if="item" class="app-section">
    <div class="app-container-center">
      <BaseBreadcrumb :items="breadcrumbs" />
      <div class="head">
        <h1 class="app-h1">
          {{ item.title }}
        </h1>
        <div class="head-actions">
          <Icon
            class="favorite"
            :name="user?.favoriteIds?.includes(item.id) ? 'heroicons-solid:star' : 'heroicons-outline:star'"
            @click.prevent="favoriteStore.toggleFavorite(item?.id ?? '')"
          />
          <NuxtLinkLocale v-if="mounted && isAdmin" :to="`/admin/item/${item?.id}`">
            <Icon name="heroicons-outline:pencil" class="edit-icon" />
          </NuxtLinkLocale>
        </div>
      </div>

      <div class="meta">
        <ItemStatus :key="item.id" :item="item" compact />
        <div v-if="item.internalId" class="id-badge">ID: {{ item.internalId }}</div>
        <ItemSharing :item="item" />
      </div>

      <main class="body">
        <div class="layout-split">
          <div class="main-col">
            <ItemGallery :item="item" />

            <iframe
              v-if="item.youtubeVideoId"
              class="video"
              :src="`https://www.youtube.com/embed/${item.youtubeVideoId.trim()}?modestbranding=1&rel=0`"
              :title="t('itemPreviewVideo')"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; loop"
              allowfullscreen
            />
            <ItemDescription :item="item" class="desc-desktop" />
            <div class="panos">
              <Pano v-for="url in item.images360" :key="url" :source="url" :item-id="item.id" />
            </div>
          </div>

          <div class="side-col">
            <ItemInfo :item="item" />

            <ItemBids />

            <QuestionThread />

            <div class="app-panel highlights-panel">
              <div class="app-panel-heading highlights-heading">
                <h3>
                  {{ t('itemHighlights') }}
                </h3>
              </div>
              <dl>
                <div v-if="item.internalId" class="highlight-row is-alt">
                  <dt class="highlight-term">ID</dt>
                  <dd class="highlight-def">
                    {{ item.internalId }}
                  </dd>
                </div>
                <div
                  v-for="(h, index) in highlights"
                  :key="index"
                  class="highlight-row"
                  :class="{
                    'is-alt': item.internalId ? index % 2 !== 0 : index % 2 === 0,
                    'is-last': index + 1 === highlights!.length,
                  }"
                >
                  <dt class="highlight-term">
                    {{ h.label }}
                  </dt>
                  <dd class="highlight-def">
                    {{ h.value }}
                  </dd>
                </div>
              </dl>
            </div>

            <ItemVehicle :item="item" />

            <ItemDescription :item="item" class="desc-mobile" />
            <div class="map-wrap">
              <StaticMap v-if="item.gps" class="map" :gps="item.gps" />
            </div>
          </div>
        </div>
      </main>

      <SimilarItems :item="item" />
    </div>
  </section>
  <ItemDetailSkeletor v-else />
</template>

<style scoped>
.head {
  @apply flex items-center justify-center gap-6 sm:justify-start;
}

.head-actions {
  @apply flex gap-3;
}

.favorite {
  @apply shrink-0 cursor-pointer text-18 text-app-amber md:text-24;
}

.edit-icon {
  @apply shrink-0 text-24;
}

.meta {
  @apply mt-3 flex flex-wrap items-center justify-center gap-4 sm:justify-start;
}

.id-badge {
  @apply inline-flex items-center rounded-full bg-app-surface-muted px-3 py-0.5 text-xs font-medium whitespace-nowrap text-app-text-muted md:text-sm;
}

.body {
  @apply py-8;
}

.layout-split {
  @apply flex flex-col justify-between gap-4 md:flex-row lg:gap-8 xl:gap-16;
}

.main-col {
  @apply w-full md:w-3/5;
}

.video {
  @apply mt-8 h-52.5 w-full rounded-lg sm:h-60 lg:h-93 xl:h-114.75;
}

.desc-desktop {
  @apply hidden md:block;
}

.panos {
  @apply mt-8 flex flex-col gap-4;
}

.side-col {
  @apply w-full md:w-2/5;
}

.highlights-panel {
  @apply mt-8 !px-0;
}

.highlights-heading {
  @apply px-4;
}

.highlight-row {
  @apply grid grid-cols-3 bg-app-surface px-4 py-3 sm:gap-4;

  &.is-alt {
    @apply !bg-app-surface-muted;
  }

  &.is-last {
    @apply rounded-b-lg;
  }
}

.highlight-term {
  @apply text-sm font-medium text-app-text-muted;
}

.highlight-def {
  @apply mt-1 text-sm text-app-text-strong sm:col-span-2 sm:mt-0;
}

.desc-mobile {
  @apply block md:hidden;
}

.map-wrap {
  @apply mt-8;
}

.map {
  @apply aspect-square w-full;
}
</style>
