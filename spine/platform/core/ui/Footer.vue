<script setup>
import logoUrl from '~/assets/images/logo.png'

const { t } = useI18n()
const { isLogged } = useUser()

// Static so SSR and client render the same links; the auth-gated favourites
// link is appended client-side (ClientOnly) to avoid a hydration mismatch.
const navigation = [
  { name: 'auction', path: '/auctions' },
  { name: 'buyNow', path: '/buy-now' },
  { name: 'sold', path: '/sold' },
  { name: 'categories', path: '/categories' },
  { name: 'contact', path: '/contact' },
]
</script>

<template>
  <footer class="footer">
    <div class="app-container">
      <div class="footer-top">
        <img :src="logoUrl" alt="Auction24.cz" class="logo" loading="lazy" />
        <div class="contacts">
          <div class="contact-item">
            <Icon name="heroicons-outline:mail" class="contact-icon" />
            <a :href="`mailto:${COMPANY.email}`">{{ COMPANY.email }}</a>
          </div>
          <div class="contact-item">
            <Icon name="heroicons-outline:phone" class="contact-icon" />
            <a href="tel:+420212246451">+420 212 246 451</a>
          </div>
          <div class="contact-item">
            <Icon name="heroicons-outline:location-marker" class="contact-icon" />
            <p>{{ COMPANY.addressLine }}</p>
          </div>
        </div>
      </div>
      <div class="nav-bar">
        <div v-for="item in navigation" :key="item.name">
          <NuxtLinkLocale :to="item.path" class="nav-link">
            {{ t(item.name) }}
          </NuxtLinkLocale>
        </div>
        <ClientOnly>
          <div v-if="isLogged">
            <NuxtLinkLocale to="/favorites" class="nav-link">
              {{ t('favorite') }}
            </NuxtLinkLocale>
          </div>
        </ClientOnly>
      </div>

      <div class="footer-bottom">
        <div class="socials">
          <div>
            <a class="social-link" target="_blank" href="https://www.facebook.com/MyAuction24">
              <Icon name="cib:facebook" class="social-icon" />
            </a>
          </div>
          <div>
            <a class="social-link" target="_blank" href="https://twitter.com/Auction_24">
              <Icon name="cib:twitter" class="social-icon" />
            </a>
          </div>
          <div>
            <a
              class="social-link"
              target="_blank"
              href="https://www.youtube.com/channel/UCk9aip68zkjXhiy45WiD1bg/videos"
            >
              <Icon name="cib:youtube" class="social-icon" />
            </a>
          </div>
        </div>
        <div class="copyright-wrap">
          <p class="copyright">{{ COMPANY.copyright }}</p>
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.footer {
  @apply border-t border-app-border bg-app-surface py-8;
}

.footer-top {
  @apply flex flex-col justify-center md:flex-row md:items-center md:justify-between;
}

.logo {
  @apply -ml-2 hidden h-10 w-auto md:hidden lg:block;
}

.contacts {
  @apply flex flex-col items-center gap-3 md:flex-row md:justify-between;
}

.contact-item {
  @apply flex items-center gap-2;
}

.contact-icon {
  @apply h-6 w-6;
}

.nav-bar {
  @apply my-4 flex flex-wrap items-center justify-center gap-4 md:justify-start;
}

.nav-link {
  @apply text-base text-app-text-muted hover:text-app-text-strong;
}

.footer-bottom {
  @apply md:flex md:items-center md:justify-between;
}

.socials {
  @apply flex justify-center space-x-6 md:order-2;
}

.social-link {
  @apply hover:text-app-primary;
}

.social-icon {
  @apply h-6 w-6;
}

.copyright-wrap {
  @apply mt-8 md:order-1 md:mt-0;
}

.copyright {
  @apply text-center text-base text-gray-400;
}
</style>
