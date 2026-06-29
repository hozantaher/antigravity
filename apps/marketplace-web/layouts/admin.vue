<script setup lang="ts">
import { Dialog, DialogPanel, TransitionChild, TransitionRoot } from '@headlessui/vue'
import { useStorage } from '@vueuse/core'

const { public: runtimePublic } = useRuntimeConfig()

const navigation = [
  { name: 'Users', path: '/admin/users', icon: 'heroicons-outline:users', dataCy: 'admin-nav-users' },
  { name: 'Items', path: '/admin/items', icon: 'mdi:car', dataCy: 'admin-nav-items' },
  { name: 'Ops', path: '/admin/ops', icon: 'heroicons-outline:chart-bar', dataCy: 'admin-nav-ops' },
  {
    name: 'Questions',
    path: '/admin/questions',
    icon: 'heroicons-outline:chat-bubble-left-right',
    dataCy: 'admin-nav-questions',
  },
  { name: 'Ratings', path: '/admin/ratings', icon: 'heroicons-outline:star', dataCy: 'admin-nav-ratings' },
  {
    name: 'Reconciliation',
    path: '/admin/reconciliation',
    icon: 'heroicons-outline:banknotes',
    dataCy: 'admin-nav-reconciliation',
  },
  ...(runtimePublic.apiTokensEnabled
    ? [{ name: 'API Tokens', path: '/admin/api-tokens', icon: 'heroicons-outline:key', dataCy: 'admin-nav-api-tokens' }]
    : []),
]

const { search } = useAdminSearch()

const mobileMenuOpen = ref(false)
// Collapsed rail state persists across reloads (VueUse-first).
const collapsed = useStorage('admin-sidebar-collapsed', false)

// Mobile nav: follow the NuxtLink (custom slot) then close the drawer. Forward the event so
// navigate() can honor modifier-clicks / preventDefault. A bare multi-statement inline handler
// fails to compile in the prod build (Vue wraps it as an expression), hence a method.
const onMobileNav = (event: MouseEvent, navigate: (e: MouseEvent) => void) => {
  navigate(event)
  mobileMenuOpen.value = false
}
</script>

<template>
  <div class="layout" :class="{ 'is-collapsed': collapsed }">
    <!-- Desktop sidebar -->
    <aside class="sidebar">
      <div class="brand">
        <NuxtLink to="/" class="brand-link">
          <Icon name="mdi:gavel" class="brand-icon" aria-hidden="true" />
          <span class="brand-name">Auction24</span>
        </NuxtLink>
        <span class="brand-tag">Admin</span>
      </div>

      <nav class="nav">
        <NuxtLink
          v-for="item in navigation"
          :key="item.name"
          v-slot="{ href, isActive, navigate }"
          custom
          :to="item.path"
        >
          <a
            :href="href ?? undefined"
            class="nav-link"
            :class="{ 'is-active': isActive }"
            :aria-current="isActive ? 'page' : undefined"
            :title="item.name"
            :data-cy="item.dataCy"
            @click="navigate"
          >
            <Icon :name="item.icon" class="nav-link-icon" aria-hidden="true" />
            <span class="nav-link-label">{{ item.name }}</span>
          </a>
        </NuxtLink>
      </nav>

      <div class="sidebar-footer">
        <div class="user-row">
          <UserMenuAvatar placement="top-start" />
        </div>
      </div>
    </aside>

    <!-- Mobile menu -->
    <TransitionRoot as="template" :show="mobileMenuOpen">
      <Dialog as="div" class="mobile-dialog" @close="mobileMenuOpen = false">
        <TransitionChild
          as="template"
          enter="transition-opacity ease-linear duration-300"
          enter-from="opacity-0"
          enter-to="opacity-100"
          leave="transition-opacity ease-linear duration-300"
          leave-from="opacity-100"
          leave-to="opacity-0"
        >
          <div class="mobile-overlay" />
        </TransitionChild>

        <div class="mobile-panel-wrap">
          <TransitionChild
            as="template"
            enter="transition ease-in-out duration-300 transform"
            enter-from="-translate-x-full"
            enter-to="translate-x-0"
            leave="transition ease-in-out duration-300 transform"
            leave-from="translate-x-0"
            leave-to="-translate-x-full"
          >
            <DialogPanel class="mobile-panel">
              <div class="mobile-head">
                <NuxtLink to="/" class="brand-link" @click="mobileMenuOpen = false">
                  <Icon name="mdi:gavel" class="brand-icon" aria-hidden="true" />
                  <span class="brand-name">Auction24</span>
                </NuxtLink>
                <button type="button" class="mobile-close-btn" aria-label="Close menu" @click="mobileMenuOpen = false">
                  <Icon name="heroicons-outline:x" class="mobile-close-icon" aria-hidden="true" />
                </button>
              </div>
              <nav class="mobile-nav">
                <NuxtLink
                  v-for="item in navigation"
                  :key="item.name"
                  v-slot="{ href, isActive, navigate }"
                  custom
                  :to="item.path"
                >
                  <a
                    :href="href ?? undefined"
                    class="nav-link"
                    :class="{ 'is-active': isActive }"
                    :aria-current="isActive ? 'page' : undefined"
                    :data-cy="item.dataCy"
                    @click="onMobileNav($event, navigate)"
                  >
                    <Icon :name="item.icon" class="nav-link-icon" aria-hidden="true" />
                    <span class="nav-link-label">{{ item.name }}</span>
                  </a>
                </NuxtLink>
              </nav>
            </DialogPanel>
          </TransitionChild>
          <div class="mobile-spacer" aria-hidden="true" />
        </div>
      </Dialog>
    </TransitionRoot>

    <!-- Content area -->
    <div class="main-area">
      <header class="navbar">
        <button
          type="button"
          class="collapse-btn"
          :title="collapsed ? 'Expand' : 'Collapse'"
          @click="collapsed = !collapsed"
        >
          <Icon name="heroicons-outline:chevron-double-left" class="collapse-icon" aria-hidden="true" />
        </button>
        <button type="button" class="menu-btn" aria-label="Open menu" @click="mobileMenuOpen = true">
          <Icon name="heroicons-outline:menu" class="menu-icon" aria-hidden="true" />
        </button>
        <div class="search-field-wrap">
          <Icon name="heroicons-outline:search" class="search-icon" aria-hidden="true" />
          <input id="search-field" v-model="search" name="search-field" class="search-input" placeholder="Search" />
        </div>
      </header>

      <div class="main">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout {
  @apply flex h-full bg-app-bg;
}

.sidebar {
  @apply hidden w-64 flex-col border-r border-app-border bg-app-surface transition-all duration-200 md:flex;
}

.is-collapsed .sidebar {
  @apply w-16;
}

.brand {
  @apply flex h-16 flex-shrink-0 items-center justify-between gap-2 border-b border-app-border px-4;
}

.brand-link {
  @apply flex items-center gap-2 overflow-hidden;
}

.brand-icon {
  @apply h-6 w-6 flex-shrink-0 text-app-primary;
}

.brand-name {
  @apply text-base font-bold whitespace-nowrap text-app-text-strong;
}

.brand-tag {
  @apply rounded-full bg-app-surface-muted px-2 py-0.5 text-xs font-medium text-app-text-muted;
}

.is-collapsed .brand {
  @apply justify-center px-0;
}

.is-collapsed .brand-name,
.is-collapsed .brand-tag {
  @apply hidden;
}

.nav {
  @apply flex-1 space-y-1 overflow-y-auto p-3;
}

.nav-link {
  @apply flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-app-text-muted;

  &:hover {
    @apply bg-app-surface-muted text-app-text;
  }

  &.is-active {
    @apply bg-app-primary/10 text-app-primary;
  }
}

.nav-link-icon {
  @apply h-5 w-5 flex-shrink-0;
}

.nav-link-label {
  @apply whitespace-nowrap;
}

.is-collapsed .nav-link {
  @apply justify-center px-0;
}

.is-collapsed .nav-link-label {
  @apply hidden;
}

.sidebar-footer {
  @apply flex-shrink-0 space-y-1 border-t border-app-border p-3;
}

.user-row {
  @apply flex items-center px-1 pt-1;
}

.mobile-dialog {
  @apply relative z-20 md:hidden;
}

.mobile-overlay {
  @apply fixed inset-0 bg-app-text-strong/40;
}

.mobile-panel-wrap {
  @apply fixed inset-0 z-40 flex;
}

.mobile-panel {
  @apply relative flex w-full max-w-xs flex-1 flex-col bg-app-surface;
}

.mobile-head {
  @apply flex h-16 flex-shrink-0 items-center justify-between border-b border-app-border px-4;
}

.mobile-close-btn {
  @apply flex h-9 w-9 items-center justify-center rounded-lg text-app-text-muted hover:bg-app-surface-muted focus:outline-none;
}

.mobile-close-icon {
  @apply h-5 w-5;
}

.mobile-nav {
  @apply flex-1 space-y-1 overflow-y-auto p-3;
}

.mobile-spacer {
  @apply w-14 flex-shrink-0;
}

.main-area {
  @apply flex flex-1 flex-col overflow-hidden;
}

.navbar {
  @apply flex h-16 flex-shrink-0 items-center gap-2 border-b border-app-border bg-app-surface px-4;
}

.collapse-btn {
  @apply hidden h-9 w-9 items-center justify-center rounded-lg text-app-text-muted hover:bg-app-surface-muted focus:outline-none md:flex;
}

.collapse-icon {
  @apply h-5 w-5;
}

.menu-btn {
  @apply flex h-9 w-9 items-center justify-center rounded-lg text-app-text-muted hover:bg-app-surface-muted focus:outline-none md:hidden;
}

.menu-icon {
  @apply h-5 w-5;
}

.search-field-wrap {
  @apply relative w-full max-w-md;
}

.search-icon {
  @apply pointer-events-none absolute inset-y-0 left-3 my-auto h-4 w-4 text-app-text-muted;
}

.search-input {
  @apply h-9 w-full rounded-lg border border-app-border bg-app-surface pr-3 pl-9 text-sm text-app-text;

  &::placeholder {
    @apply text-app-text-muted;
  }

  &:focus {
    @apply border-app-primary ring-1 ring-app-primary outline-none;
  }
}

.main {
  @apply flex flex-1 overflow-y-auto;
}
</style>
