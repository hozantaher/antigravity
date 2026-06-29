# SEO

auction24 is server-rendered and crawled across 12 locales (`strategy: prefix_except_default`, default `cz`
unprefixed). Search-engine-facing concerns live in the HTML head, the sitemap, and the **page** routes —
never in `/api/**` (that's the machine contract AutoLine imports, keyed on `internalId`; changing it is the
one way to break that integration, and nothing here touches it).

## What's in place

- **Per-page meta** via `useSeo()` (`features/platform/core/logic/useSeo.ts`): title (+ ` | Auction24.cz`),
  og/twitter title, optional description/image, `noindex`.
- **Canonical + hreflang** for all 12 locales via `useLocaleHead()` in `app.vue`.
- **robots.txt** (`server/routes/robots.txt.ts`) and a locale-split **sitemap.xml** with hreflang clusters
  (`server/routes/sitemap.xml.ts`, `server/utils/sitemap.ts`).
- **JSON-LD**: Organization (`app.vue`); Product + Vehicle/Car + Offer (`itemCondition: UsedCondition`,
  `priceValidUntil`) + BreadcrumbList on the item page; WebSite + SearchAction on the homepage; ItemList on
  listing pages (`features/platform/core/logic/useItemListLd.ts`).
- **Visible breadcrumbs** (`BaseBreadcrumb`) on the item + category pages.
- **og:image** sized to 1200×630 JPEG via `useImageProcessing().getOgImage()`.
- **SEO-friendly item URLs** `/item/<id>/<slug>` (`itemSlug` / `itemPath` in `models/Item.ts`): the `<id>`
  segment resolves the page, the title-derived slug is cosmetic. `pages/item/[itemId]/[[slug]].vue`
  301-canonicalises a bare `/item/<id>` or a stale slug. Every internal link goes through `itemPath()`.

## Deferred (intentional)

- **Sitemap slug URLs + `<image:image>`**: `server/utils/sitemap.ts` still emits bare `/item/<id>` (which
  301s to the slug — one redirect hop, not broken). Emitting the slug + an image entry needs
  `listSitemapItems` (`server/repos/itemRepo.ts`) to also return `title` / `image` (a small select change).
- **`mileageFromOdometer`** in the vehicle JSON-LD: there is no typed odometer field on `Item` /
  `VehicleSpecs` (mileage lives in free-form `highlights`). Add a typed field first, then map it.
- **Default brand og:image**: `app.vue` falls back to the 310×310 icon for non-item pages. Needs a 1200×630
  brand asset in `public/`.
- **Sitemap sharding**: one locale child lists every item; revisit before the catalogue passes the
  50k-URLs-per-file sitemap limit.
