import path from 'path'
import { fileURLToPath } from 'node:url'
import MagicString from 'magic-string'
import tailwindcss from '@tailwindcss/vite'

// Port of garaaage-main's `auto-reference-tailwind` plugin: Tailwind v4 requires a
// `@reference` to the main stylesheet for `@apply` to resolve theme tokens inside
// scoped <style> blocks. This injects it automatically so components don't have to.
function autoReferenceTailwind() {
  return {
    name: 'auto-reference-tailwind',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (id.includes('.vue') && id.includes('type=style')) {
        if (code.includes('@reference')) return
        if (!code.includes('@apply')) return
        const fileDir = path.dirname(id.split('?')[0]!)
        const targetPath = path.join(process.cwd(), 'assets/css/main.css')
        let relativePath = path.relative(fileDir, targetPath).split(path.sep).join('/')
        if (!relativePath.startsWith('.')) relativePath = './' + relativePath
        const ms = new MagicString(code)
        ms.prepend(`@reference "${relativePath}";\n`)
        return { code: ms.toString(), map: ms.generateMap({ hires: true }) }
      }
    },
  }
}

export default defineNuxtConfig({
  compatibilityDate: '2025-03-24',
  devtools: { enabled: true },
  alias: {
    '@vueform/multiselect/themes/default.css': fileURLToPath(new URL('./node_modules/@vueform/multiselect/themes/default.css', import.meta.url))
  },

  modules: ['@nuxt/icon', '@nuxt/fonts', '@nuxtjs/i18n', '@nuxt/eslint', '@vueuse/nuxt', 'nuxt-gtag'],

  // GA4 (public measurement ID, baked at build). Manual init: gtag.js loads only
  // after the user accepts cookies in CookiesBar — see plugins/gtag-consent.client.ts.
  // Unset GTAG_ID → no script, useGtag() is a no-op (parity with the other features).
  gtag: {
    id: 'G-MKYPZ2L2F4',
    initMode: 'manual',
    initCommands: [
      [
        'consent',
        'default',
        {
          analytics_storage: 'denied',
          ad_storage: 'denied',
          ad_user_data: 'denied',
          ad_personalization: 'denied',
          wait_for_update: 500,
        },
      ],
    ],
  },

  // Auto-import enums + helper functions from models/ (ItemType, defaultSort,
  // itemStatus, isAuctionLive, …) the way unplugin-auto-import did in auction24.
  imports: {
    // Nuxt only auto-imports the top level of composables/ by default, so the
    // nested admin composables and each feature module's logic/ need explicit
    // registration. features/*/logic holds per-module composables (vertical-axis
    // "behind the contract"), auto-imported with bare names like composables/.
    dirs: ['models', 'features/**/logic'],
  },

  // Vertical-axis feature modules (plan.md): each features/<domain>/ui/ holds that module's UI
  // top-node, auto-imported with bare names (pathPrefix:false) exactly as when the components
  // lived flat in components/ — so <BaseInput> etc. keep resolving with no usage-site changes.
  // The scan is restricted to **/ui/** so sibling module files (contract.ts, README.md, logic/)
  // are NOT mis-registered as components (two contract.ts would otherwise collide as "Contract").
  // ~/components stays scanned for not-yet-migrated components (strangler).
  components: {
    dirs: [
      '~/components',
      // Exclude the playground dev-gallery from the bare-name scan; it gets a dedicated entry
      // below so its <Playground*> component names are preserved via an explicit prefix.
      { path: '~/features', pathPrefix: false, pattern: '**/ui/**', ignore: ['**/playground/**'] },
      {
        path: '~/features/platform/design-system/ui/playground',
        pathPrefix: false,
        prefix: 'Playground',
        extensions: ['vue'],
      },
    ],
  },

  css: ['~/assets/css/reset.css', '~/assets/css/main.css'],

  app: {
    head: {
      viewport: 'width=device-width, initial-scale=1',
      htmlAttrs: { lang: 'cs' },
      title: 'Auction24.cz',
      meta: [{ charset: 'utf-8' }, { name: 'description', content: 'Auction24.cz — aukce a prodej vozidel.' }],
      link: [
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' },
        { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16x16.png' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-icon-180x180.png' },
        { rel: 'manifest', href: '/manifest.json' },
      ],
    },
  },

  runtimeConfig: {
    // Server-only. SendGrid delivers the auth e-mails (verification + password
    // reset); without the key those endpoints fail with 502.
    sendgridApiKey: process.env.SENDGRID_API_KEY || '',
    sendgridFromNoReply: process.env.SENDGRID_FROM_NO_REPLY || '',
    // Vincario VIN decoder (server-only). When unset, the admin "Decode VIN" button is hidden
    // (public.vincarioEnabled=false) and the decode endpoint returns 500.
    vincarioApiKey: process.env.VINCARIO_API_KEY || '',
    vincarioSecretKey: process.env.VINCARIO_SECRET_KEY || '',
    // HMAC pepper for admin-issued API tokens (server-only). Unset → token creation
    // returns 500 and public.apiTokensEnabled is false (nav item hidden).
    internalApiSecret: process.env.INTERNAL_API_SECRET || '',
    // Shared secret for the close-auctions cron endpoint (server-only). Cloud Scheduler
    // sends it as `Authorization: Bearer …`. Unset → /api/cron/close-auctions returns 503.
    cronSecret: process.env.CRON_SECRET || '',
    // Inbox that contact-form submissions and price offers are e-mailed to (server-only).
    // Unset → the handler falls back to COMPANY.email, so notifications work out of the box.
    contactNotifyEmail: process.env.CONTACT_NOTIFY_EMAIL || '',
    // Fakturoid v3 OAuth client credentials (server-only). Unset → deposit proformas
    // are skipped (best-effort); the bank-transfer flow itself keeps working.
    fakturoidSlug: process.env.FAKTUROID_SLUG || '',
    fakturoidClientId: process.env.FAKTUROID_CLIENT_ID || '',
    fakturoidClientSecret: process.env.FAKTUROID_CLIENT_SECRET || '',
    // Fio read-only API tokens (server-only) — the fio-payments cron pulls incoming
    // movements per currency account. Unset → that account is skipped.
    fioTokenCzk: process.env.FIO_TOKEN_CZK || '',
    fioTokenEur: process.env.FIO_TOKEN_EUR || '',
    // Deposit collection accounts shown to the payer (public payment details, so
    // plain values with safe defaults; override via env when the accounts change).
    depositIbanCzk: process.env.DEPOSIT_IBAN_CZK || 'CZ8820100000002903525501',
    depositIbanEur: process.env.DEPOSIT_IBAN_EUR || 'CZ7920100000002503525502',
    depositAccountCzk: process.env.DEPOSIT_ACCOUNT_CZK || '2903525501/2010',
    depositAccountEur: process.env.DEPOSIT_ACCOUNT_EUR || '2503525502/2010',
    // Account holder shown as the payment recipient. The deposit accounts above belong
    // to EAST WEST 24, not the app's operating company (COMPANY.name) — keep this in sync
    // with whoever owns depositAccount*/depositIban*.
    depositRecipient: process.env.DEPOSIT_RECIPIENT || 'East West 24 s.r.o.',
    // Stripe card payments for the deposit (server-only). Unset secret key → the
    // card option is hidden (public.stripeEnabled) and /api/deposit/checkout 503s.
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    // DeepL translation (server-only). Powers the admin item editor's "translate to other
    // languages" action. Unset → public.deeplEnabled=false (button hidden) and /api/translate 503s.
    deeplApiKey: process.env.DEEPL_API_KEY || '',
    public: {
      apiBase: '/api',
      // Absolute origin baked into e-mail action links (/auth/verify, /auth/reset).
      baseUrl: process.env.BASE_URL || '',
      // Drives the admin "Decode VIN" button visibility (true when both Vincario keys are set).
      vincarioEnabled: Boolean(process.env.VINCARIO_API_KEY && process.env.VINCARIO_SECRET_KEY),
      // Gates the admin "API Tokens" nav item (true when INTERNAL_API_SECRET is set).
      apiTokensEnabled: Boolean(process.env.INTERNAL_API_SECRET),
      // Gates the admin "translate to other languages" button (true when DEEPL_API_KEY is set).
      deeplEnabled: Boolean(process.env.DEEPL_API_KEY),
      // Shows the card option in the deposit wizard. Explicit opt-in: the key alone
      // isn't enough (a test-mode key would otherwise surface a card option that
      // declines real cards). The checkout endpoint enforces the same flag (503).
      stripeEnabled:
        Boolean(process.env.STRIPE_SECRET_KEY) && ['1', 'true'].includes(process.env.STRIPE_CARD_ENABLED ?? ''),
      // Master switch for the recommendation engine (detail rail + tracking + build/newsletter
      // crons). Opt-in like stripeEnabled; when off everything degrades to popularity/no-op.
      recoEnabled: ['1', 'true'].includes(process.env.RECO_ENABLED ?? ''),
      // Deterministic listing-enrichment cron (VIN auto-decode + DeepL auto-translate into empty
      // locales). Opt-in like recoEnabled; off → the enrich-listings cron is a no-op.
      enrichEnabled: ['1', 'true'].includes(process.env.ENRICH_ENABLED ?? ''),
      // Firebase Web config (public by design). Baked from FIREBASE_* env at
      // build; overridable at runtime via NUXT_PUBLIC_FIREBASE_* if needed.
      firebase: {
        apiKey: process.env.FIREBASE_API_KEY || '',
        authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
        projectId: process.env.FIREBASE_PROJECT_ID || '',
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
        appId: process.env.FIREBASE_APP_ID || '',
        // Set FIREBASE_AUTH_EMULATOR_HOST (e.g. 127.0.0.1:9099) for local dev/tests.
        authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST || '',
      },
      imageProcessingUrl:
        process.env.IMAGE_PROCESSING_URL ||
        'https://europe-west3-garaaage-auction24.cloudfunctions.net/ext-image-processing-api-handler',
      // Routes image requests through the same-origin /img cache proxy instead of hitting the
      // processing function directly on every load — so the platform CDN can cache its (already
      // 1-year-cacheable) output across visitors. Opt-in like recoEnabled; off → unchanged direct
      // URLs. See docs/image-performance.md.
      imageCacheEnabled: ['1', 'true'].includes(process.env.IMAGE_CACHE_ENABLED ?? ''),
    },
  },

  // Admin and profile are authed areas; render them client-side so their
  // Bearer-token fetches (client-only) don't run anonymous during SSR — which
  // would also hydrate-mismatch the user-specific content against the client.
  routeRules: {
    // Baseline security headers on every response. Only render-safe directives — a full script-src/
    // style-src CSP needs per-request nonces + browser verification, tracked separately; these add the
    // clickjacking/sniffing/referrer/transport protections with no risk to rendering.
    '/**': {
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'Content-Security-Policy': "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      },
    },
    '/admin/**': { ssr: false },
    '/profile': { ssr: false },
    '/profile/**': { ssr: false },
    // Component gallery — client-only, it showcases client-only/auth-driven widgets.
    '/playground': { ssr: false },
  },

  i18n: {
    // Locale YAML lives in the i18n feature module (features/i18n/locales). restructureDir points
    // @nuxtjs/i18n there; langDir stays relative to it (plan.md §7.5).
    restructureDir: 'features/platform/i18n',
    langDir: 'locales',
    defaultLocale: 'cz',
    strategy: 'prefix_except_default',
    // Absolute origin for the hreflang/canonical alternates emitted by useLocaleHead (mirrors
    // runtimeConfig.public.baseUrl). Empty in dev → relative alternates (i18n warns); prod sets BASE_URL.
    baseUrl: process.env.BASE_URL || '',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'i18n_locale',
      // Only the bare `/` auto-localizes, once, when no cookie is set yet. Deep links never
      // redirect, so crawlers stay on the canonical per-locale URLs.
      redirectOn: 'root',
      alwaysRedirect: false,
    },
    // `language` is the BCP 47 tag (used for <html lang> + og:locale via app.vue). The `code`
    // is the app's own non-standard locale id (e.g. `cz`, `ua`, `rs`) and must NOT be used as
    // a language tag — `cz` is a country code, Czech is `cs`; `ua`→`uk`, `rs`/`me`→`sr-*`.
    locales: [
      { code: 'cz', name: 'Čeština', language: 'cs-CZ', file: 'cz.yml' },
      { code: 'en', name: 'English', language: 'en-US', file: 'en.yml' },
      { code: 'de', name: 'Deutsch', language: 'de-DE', file: 'de.yml' },
      { code: 'fr', name: 'Français', language: 'fr-FR', file: 'fr.yml' },
      { code: 'pl', name: 'Polski', language: 'pl-PL', file: 'pl.yml' },
      { code: 'nl', name: 'Nederlands', language: 'nl-NL', file: 'nl.yml' },
      { code: 'ru', name: 'Русский', language: 'ru-RU', file: 'ru.yml' },
      { code: 'ua', name: 'Українська', language: 'uk-UA', file: 'ua.yml' },
      { code: 'hr', name: 'Hrvatski', language: 'hr-HR', file: 'hr.yml' },
      { code: 'rs', name: 'Српски', language: 'sr-RS', file: 'rs.yml' },
      { code: 'me', name: 'Crnogorski', language: 'sr-ME', file: 'me.yml' },
      { code: 'ar', name: 'العربية', language: 'ar', dir: 'rtl', file: 'ar.yml' },
    ],
  },

  icon: {
    mode: 'svg',
    serverBundle: {
      collections: ['heroicons-outline', 'heroicons-solid', 'flag', 'circle-flags', 'cib', 'mdi', 'ic', 'carbon'],
    },
    clientBundle: {
      scan: true,
      sizeLimitKb: 512,
    },
  },

  fonts: {
    families: [
      { name: 'Lato', provider: 'google', global: true, weights: [300, 400, 700], styles: ['normal', 'italic'] },
      { name: 'Fira Code', provider: 'google', global: true, weights: [400, 700] },
    ],
    defaults: {
      fallbacks: {
        'sans-serif': ['Lato'],
      },
    },
  },

  build: {
    transpile: ['vue-toastification'],
  },

  // auction24 used vite-plugin-pages, which passes route params as component
  // props. Replicate that so `defineProps<{ itemId }>()` etc. keep working.
  hooks: {
    'pages:extend'(pages) {
      // Drop junk routes for sub-component folders (ui/, components/, highlights/) —
      // these .vue files are imported explicitly, not navigated to.
      const prune = (list: any[]) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const p = list[i]
          if (
            p.file &&
            (p.file.includes('/ui/') || p.file.includes('/components/') || p.file.includes('/highlights/'))
          ) {
            list.splice(i, 1)
            continue
          }
          if (p.children) prune(p.children)
        }
      }
      prune(pages)
      // Pass route params as component props (auction24 used vite-plugin-pages).
      const setProps = (list: any[]) => {
        for (const page of list) {
          page.props = true
          if (page.children) setProps(page.children)
        }
      }
      setProps(pages)
    },
  },

  vite: {
    // autoReference must run BEFORE @tailwindcss/vite so the injected @reference
    // is present when Tailwind resolves @apply inside component <style> blocks.
    plugins: [autoReferenceTailwind(), tailwindcss()],
    // Let the Cloudflare named tunnel host through Vite's dev-server host check;
    // without it tunneled requests (Host: mcp.garaaage.com) are rejected with 403.
    server: {
      allowedHosts: ['mcp.garaaage.com'],
    },
    // Pre-bundle these so Vite doesn't discover them mid-navigation and force a
    // full page reload (CJS deps like nprogress/numeral are the usual culprits).
    optimizeDeps: {
      include: [
        '@headlessui/vue',
        '@vue/devtools-core',
        '@vue/devtools-kit',
        '@vueform/multiselect',
        'firebase/app',
        'firebase/auth',
        'nprogress',
        'qrcode',
        'vue-skeletor',
        'vuedraggable',
      ],
    },
  },
})
