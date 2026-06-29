<script setup>
const { t, locale } = useI18n()

const { accepted, accept } = useCookieConsent()

// localStorage is client-only; gate render on mount so SSR and the first client
// render agree (both empty) instead of mismatching on a returning visitor.
const mounted = ref(false)
onMounted(() => (mounted.value = true))
</script>

<template>
  <div v-if="mounted && !accepted" class="bar">
    <div class="bar-inner">
      <div class="app-container bar-padding">
        <div class="bar-row">
          <div class="message">
            <span class="icon-wrap">
              <Icon name="heroicons-outline:shield-exclamation" class="icon" aria-hidden="true" />
            </span>
            <p class="message-text">
              <span class="message-inner">
                {{ t('cookies') }}
                <a :href="getGdprLink(locale)" target="_blank" class="app-link link"
                  >{{ t('privacyPolicy') }}<span aria-hidden="true">&rarr;</span></a
                >
              </span>
            </p>
          </div>
          <div class="actions">
            <button type="button" class="app-btn" @click="accept">
              {{ t('accept') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bar {
  @apply fixed inset-x-0 bottom-0 z-1;
}

.bar-inner {
  @apply border-t border-app-border bg-app-surface text-app-text shadow-lg;
}

.bar-padding {
  @apply py-3;
}

.bar-row {
  @apply flex flex-wrap items-center justify-between;
}

.message {
  @apply flex w-0 flex-1 items-center;
}

.icon-wrap {
  @apply flex rounded-lg bg-app-primary/10 p-2;
}

.icon {
  @apply h-6 w-6 text-app-primary;
}

.message-text {
  @apply ml-3 truncate font-medium text-app-text;
}

.message-inner {
  @apply inline whitespace-pre-line;
}

.link {
  @apply underline;
}

.actions {
  @apply order-2 flex-shrink-0 sm:order-3 sm:ml-3;
}
</style>
