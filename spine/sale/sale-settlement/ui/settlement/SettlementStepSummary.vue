<script setup lang="ts">
import type { Settlement } from '~/models'

const props = defineProps<{
  settlement: Settlement | undefined
  loading?: boolean
}>()

const emit = defineEmits<{
  next: []
}>()

const { t } = useI18n()

const finalPriceLabel = computed(() => formatPrice(props.settlement?.finalPrice))
const creditLabel = computed(() => formatPrice(props.settlement?.depositCredit))
const amountDueLabel = computed(() => formatPrice(props.settlement?.amountDue))
const hasCredit = computed(() => (props.settlement?.depositCredit?.amount ?? 0) > 0)
const fullyCovered = computed(() => (props.settlement?.amountDue?.amount ?? 0) === 0)
</script>

<template>
  <div class="step">
    <h4 class="step-heading">{{ t('settlement.summaryHeading') }}</h4>
    <p class="step-intro">{{ t('settlement.summaryIntro') }}</p>

    <div class="sum-lines">
      <div class="sum-row">
        <span class="sum-label">{{ t('settlement.finalPrice') }}</span>
        <span class="sum-value" dir="ltr">{{ finalPriceLabel }}</span>
      </div>
      <div v-if="hasCredit" class="sum-row is-credit">
        <span class="sum-label">{{ t('settlement.depositCredit') }}</span>
        <span class="sum-value" dir="ltr">−{{ creditLabel }}</span>
      </div>
      <div class="sum-row is-due">
        <span class="sum-label">{{ t('settlement.amountDue') }}</span>
        <span class="sum-value is-big" dir="ltr">{{ amountDueLabel }}</span>
      </div>
    </div>

    <div v-if="fullyCovered" class="covered-note">
      <Icon name="heroicons-solid:check-circle" class="covered-icon" aria-hidden="true" />
      <span class="covered-text">{{ t('settlement.fullyCoveredByDeposit') }}</span>
    </div>

    <div class="actions">
      <button type="button" class="app-btn next-btn" :disabled="loading" @click="emit('next')">
        <Icon v-if="loading" name="mdi:loading" class="spin-icon" aria-hidden="true" />
        {{ fullyCovered ? t('settlement.confirmFree') : t('settlement.continue') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.step {
  @apply px-1 py-2;
}

.step-heading {
  @apply text-lg font-bold text-app-text-strong;
}

.step-intro {
  @apply mt-1 mb-4 text-sm text-app-text-muted;
}

.sum-lines {
  @apply mb-4 overflow-hidden rounded-lg border border-app-border bg-app-surface-muted;
}

.sum-row {
  @apply flex items-center justify-between gap-3 border-b border-app-border px-4 py-3;

  &.is-credit {
    @apply text-app-green;
  }

  &.is-due {
    @apply border-b-0 bg-app-surface;
  }
}

.sum-label {
  @apply shrink-0 text-sm text-app-text-muted;
}

.sum-value {
  @apply truncate text-sm font-semibold text-app-text-strong;

  &.is-big {
    @apply font-mono text-lg font-extrabold text-app-primary;
  }
}

.covered-note {
  @apply mb-4 flex items-center gap-2 rounded-lg border border-app-green/25 bg-app-green/5 px-3.5 py-2.5;
}

.covered-icon {
  @apply h-4 w-4 shrink-0 text-app-green;
}

.covered-text {
  @apply text-xs text-app-text;
}

.actions {
  @apply flex gap-3;
}

.next-btn {
  @apply w-full items-center gap-2;
}

.spin-icon {
  @apply h-4 w-4 animate-spin;
}
</style>
