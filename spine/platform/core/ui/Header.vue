<script lang="ts" setup>
import { Popover, PopoverButton, PopoverOverlay, PopoverPanel } from '@headlessui/vue'
import logoUrl from '~/assets/images/logo.png'
import logoSmallUrl from '~/assets/images/logo-small.png'

const { t } = useI18n()
const router = useRouter()
const localePath = useLocalePath()

const { user, isLogged, isAdmin, signOut } = useUser()

// Static so SSR and client render the same links; the auth-gated favourites
// link is appended client-side (ClientOnly) to avoid a hydration mismatch.
const navigation = [
  { name: 'auction', path: '/auctions' },
  { name: 'buyNow', path: '/buy-now' },
  { name: 'sold', path: '/sold' },
  { name: 'categories', path: '/categories' },
]

const route = useRoute()
const q = ref(route.params.q?.toString() ?? '')

// Keep the box in sync with the route — deep links, back/forward, landing on /search/x.
watch(
  () => route.params.q,
  val => (q.value = val?.toString() ?? ''),
)

const search = () => {
  if (!q.value) return
  // Encode so terms containing "/" (e.g. "X6 / 2009") stay a single route param
  // instead of splitting the path into segments and 404-ing.
  router.push(localePath(`/search/${encodeURIComponent(q.value)}`))
}

// The native clear (×) on type="search" empties the box and fires `search`. Drop the
// active search filter by returning home instead of leaving the stale results behind.
const onClear = () => {
  if (!q.value && route.path.startsWith('/search/')) router.push(localePath('/'))
}
</script>

<template>
  <div class="header">
    <Popover v-slot="{ open, close }" as="nav" class="nav">
      <div class="app-container">
        <div class="bar">
          <div class="bar-start">
            <NuxtLink :to="localePath('/')" class="logo">
              <img class="logo-img logo-img-small" :src="logoSmallUrl" alt="Auction24.cz" />
              <img class="logo-img logo-img-full" :src="logoUrl" alt="Auction24.cz" />
            </NuxtLink>
            <div class="nav-links">
              <NuxtLink
                v-for="item in navigation"
                :key="item.name"
                v-slot="{ isActive, href, navigate }"
                :to="localePath(item.path)"
                custom
              >
                <a :href="href ?? undefined" class="nav-link" :class="{ 'is-active': isActive }" @click="navigate">
                  {{ t(item.name) }}
                </a>
              </NuxtLink>
              <ClientOnly>
                <NuxtLink v-if="isLogged" v-slot="{ isActive, href, navigate }" :to="localePath('/favorites')" custom>
                  <a
                    :href="href ?? undefined"
                    class="nav-link is-favorite"
                    :class="{ 'is-active': isActive }"
                    @click="
                      () => {
                        navigate()
                        close()
                      }
                    "
                  >
                    {{ t('favorite') }}
                  </a>
                </NuxtLink>
              </ClientOnly>
            </div>
          </div>

          <div class="bar-center">
            <div class="search-box">
              <label for="search" class="visually-hidden">{{ t('findVehicle') }}</label>
              <div class="search-field">
                <div class="search-icon">
                  <Icon name="heroicons-solid:search" class="search-icon-svg" aria-hidden="true" />
                </div>
                <input
                  id="search"
                  v-model="q"
                  name="search"
                  class="search-input"
                  :placeholder="t('findVehicle')"
                  type="search"
                  @keyup.enter="search"
                  @search="onClear"
                />
              </div>
            </div>
            <Language class="lang-desktop" />
          </div>
          <div class="menu-toggle">
            <PopoverButton class="menu-toggle-btn">
              <span class="visually-hidden">{{ t('openMainMenu') }}</span>
              <Icon v-if="!open" name="heroicons-solid:menu" class="menu-toggle-icon" aria-hidden="true" />
              <Icon v-else name="heroicons-solid:x" class="menu-toggle-icon" aria-hidden="true" />
            </PopoverButton>
          </div>
          <div class="avatar-slot">
            <ClientOnly>
              <UserMenuAvatar />
            </ClientOnly>
          </div>
        </div>
      </div>
      <PopoverOverlay class="overlay" />
      <PopoverPanel class="panel">
        <div class="mobile-nav">
          <NuxtLink
            v-for="item in navigation"
            :key="item.name"
            v-slot="{ isActive, href, navigate }"
            :to="localePath(item.path)"
            custom
          >
            <PopoverButton
              as="a"
              :href="href ?? undefined"
              class="mobile-link"
              :class="{ 'is-active': isActive }"
              @click="
                () => {
                  navigate()
                  close()
                }
              "
            >
              {{ t(item.name) }}
            </PopoverButton>
          </NuxtLink>
          <ClientOnly>
            <NuxtLink v-if="isLogged" v-slot="{ isActive, href, navigate }" :to="localePath('/favorites')" custom>
              <PopoverButton
                as="a"
                :href="href ?? undefined"
                class="mobile-link"
                :class="{ 'is-active': isActive }"
                @click="
                  () => {
                    navigate()
                    close()
                  }
                "
              >
                {{ t('favorite') }}
              </PopoverButton>
            </NuxtLink>
          </ClientOnly>
          <Language class="lang-mobile" />
        </div>
        <ClientOnly>
          <div v-if="isLogged" class="mobile-account">
            <div class="account-head">
              <div class="account-avatar">
                <LettersAvatar :name="user!.fullName" />
              </div>
              <div class="account-info">
                <div class="account-name">
                  {{ user!.fullName }}
                </div>
                <div class="account-email">
                  {{ user!.email }}
                </div>
              </div>
            </div>
            <div class="account-actions">
              <NuxtLink v-slot="{ isActive, href, navigate }" :to="localePath('/profile')" custom>
                <PopoverButton
                  as="a"
                  :href="href ?? undefined"
                  class="account-link"
                  :class="{ 'is-active': isActive }"
                  @click="
                    () => {
                      navigate()
                      close()
                    }
                  "
                >
                  {{ t('accountTitle') }}
                </PopoverButton>
              </NuxtLink>
              <NuxtLink v-if="isAdmin" v-slot="{ isActive, href, navigate }" :to="localePath('/admin/users')" custom>
                <PopoverButton
                  as="a"
                  :href="href ?? undefined"
                  class="account-link"
                  :class="{ 'is-active': isActive }"
                  @click="
                    () => {
                      navigate()
                      close()
                    }
                  "
                >
                  Admin
                </PopoverButton>
              </NuxtLink>
              <PopoverButton as="a" href="#" class="account-link" @click="signOut(true)">
                {{ t('logout') }}
              </PopoverButton>
            </div>
          </div>
          <div v-else class="mobile-account">
            <NuxtLinkLocale to="/sign" class="login-link" @click="close">
              <div class="account-avatar">
                <Icon name="heroicons-outline:user-circle" class="login-icon" />
              </div>
              <div class="account-info">
                <div class="account-name">
                  {{ t('login') }}
                </div>
              </div>
            </NuxtLinkLocale>
          </div>
        </ClientOnly>
      </PopoverPanel>
    </Popover>
  </div>
  <div class="header-spacer" />
</template>

<style scoped>
.visually-hidden {
  @apply sr-only;
}

.header {
  @apply fixed z-10 w-full;
}

/* :deep — like .overlay/.panel below, headlessui's Popover root <nav> doesn't
   carry the scope id, so a plain .nav rule wouldn't match (transparent header). */
.header :deep(.nav) {
  @apply border-b border-app-border bg-app-surface;
}

.bar {
  @apply flex h-16 justify-between;
}

.bar-start {
  @apply flex;
}

.logo {
  @apply flex shrink-0 items-center;
}

.logo-img {
  @apply w-auto;
}

/* Small 24-box on phone only — frees horizontal space for the search input. */
.logo-img-small {
  @apply block h-8 sm:hidden mr-2;
}

.logo-img-full {
  @apply hidden h-8 sm:block lg:h-10;
}

.nav-links {
  @apply hidden lg:ml-6 lg:flex lg:space-x-8;
}

.nav-link {
  @apply inline-flex items-center border-b-2 border-transparent px-1 pt-1 text-sm font-medium uppercase text-app-text-muted hover:border-app-border-strong hover:text-app-text;

  &.is-active {
    @apply !border-app-primary text-app-text-strong;
  }

  &.is-favorite {
    @apply !hidden xl:!inline-flex;
  }
}

.bar-center {
  @apply flex flex-1 items-center justify-center gap-4 px-2 lg:ml-6 lg:justify-end;
}

.search-box {
  @apply w-full max-w-lg lg:max-w-xs;
}

.search-field {
  @apply relative;
}

.search-icon {
  @apply pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3;
}

.search-icon-svg {
  @apply h-5 w-5 text-gray-400;
}

.search-input {
  @apply block w-full rounded-lg border border-app-border bg-app-surface py-2 pr-3 pl-10 leading-5 placeholder-gray-500 focus:border-app-primary/30 focus:placeholder-gray-400 focus:ring-1 focus:ring-app-primary/30 focus:outline-none sm:text-sm;
}

.lang-desktop {
  @apply hidden lg:block;
}

.menu-toggle {
  @apply flex items-center lg:hidden;
}

.menu-toggle-btn {
  @apply inline-flex items-center justify-center rounded-lg p-2 text-app-text hover:bg-app-surface-muted hover:text-app-text-strong focus:outline-none;
}

.menu-toggle-icon {
  @apply block h-6 w-6;
}

.avatar-slot {
  @apply hidden lg:ml-4 lg:flex lg:items-center;
}

/* :deep — headlessui's Popover root <nav> and the PopoverButton links don't
   carry the scope id, so plain scoped rules wouldn't match them. Anchored on
   .header (which does carry it), these stay scoped to this component. */
.header :deep(.overlay) {
  @apply fixed inset-x-0 top-16 bottom-0 bg-black opacity-30 lg:hidden;
}

.header :deep(.panel) {
  @apply absolute inset-x-0 top-16 bg-app-surface pb-3 shadow-lg lg:hidden;
}

.mobile-nav {
  @apply space-y-1 pt-2 pb-3;
}

.header :deep(.mobile-link) {
  @apply block border-l-4 border-transparent py-2 pr-4 pl-3 text-base font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-800;
}

.header :deep(.mobile-link.is-active) {
  @apply !border-app-primary !bg-app-primary/10 !text-app-primary;
}

.header :deep(.lang-mobile) {
  @apply px-3 lg:hidden;
}

.mobile-account {
  @apply border-t border-gray-200 pt-4 pb-3;
}

.account-head {
  @apply flex items-center px-4;
}

.account-avatar {
  @apply flex-shrink-0;
}

.account-info {
  @apply ml-3;
}

.account-name {
  @apply text-base font-medium text-gray-800;
}

.account-email {
  @apply text-sm font-medium text-gray-500;
}

.account-actions {
  @apply mt-3 space-y-1;
}

.header :deep(.account-link) {
  @apply block px-4 py-2 text-base font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800;
}

.header :deep(.account-link.is-active) {
  @apply !bg-gray-300;
}

.login-link {
  @apply flex items-center px-4;
}

.login-icon {
  @apply text-32 text-gray-500;
}

.header-spacer {
  @apply h-16;
}
</style>
