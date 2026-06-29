<script setup lang="ts">
import type { NuxtError } from '#app'
import logoUrl from '~/assets/images/logo.png'

defineProps<{ error: NuxtError }>()

const handleError = () => clearError({ redirect: '/' })

useSeoMeta({ robots: 'noindex' })
</script>

<template>
  <div class="error">
    <main class="main">
      <div class="logo-wrap">
        <NuxtLinkLocale to="/" class="logo-link">
          <img class="logo" :src="logoUrl" alt="Auction24.cz" />
        </NuxtLinkLocale>
      </div>
      <div class="body">
        <div class="error-text">
          <p class="status">{{ error?.statusCode ?? 404 }} error</p>
          <h1 class="heading">Page not found.</h1>
          <p class="desc">Sorry, we couldn’t find the page you’re looking for.</p>
          <div class="action">
            <a href="#" class="app-text-btn home-link" @click.prevent="handleError"
              >Go back home<span aria-hidden="true"> &rarr;</span></a
            >
          </div>
        </div>
      </div>
    </main>
    <footer class="footer">
      <nav class="nav">
        <NuxtLinkLocale to="/contact" class="nav-link">Contact Support</NuxtLinkLocale>
      </nav>
    </footer>
  </div>
</template>

<style scoped>
.error {
  @apply flex min-h-full flex-col bg-white pt-16 pb-12;
}

.main {
  @apply mx-auto flex w-full max-w-7xl flex-grow flex-col justify-center px-4 sm:px-6 lg:px-8;
}

.logo-wrap {
  @apply flex flex-shrink-0 justify-center;
}

.logo-link {
  @apply inline-flex;
}

.logo {
  @apply h-12 w-auto;
}

.body {
  @apply py-16;
}

.error-text {
  @apply text-center;
}

.status {
  @apply text-sm font-semibold tracking-wide text-app-red uppercase;
}

.heading {
  @apply mt-2 text-32 font-extrabold tracking-tight text-gray-900 sm:text-32;
}

.desc {
  @apply mt-2 text-base text-gray-500;
}

.action {
  @apply mt-6;
}

.home-link {
  @apply font-medium;
}

.footer {
  @apply mx-auto w-full max-w-7xl flex-shrink-0 px-4 sm:px-6 lg:px-8;
}

.nav {
  @apply flex justify-center space-x-4;
}

.nav-link {
  @apply text-sm font-medium text-gray-500 hover:text-gray-600;
}
</style>
