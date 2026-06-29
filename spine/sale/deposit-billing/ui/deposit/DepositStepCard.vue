<script setup lang="ts">
import type { DepositCurrency } from '~/models'

const props = defineProps<{
  currency: DepositCurrency
  amount: number
}>()

const emit = defineEmits<{
  back: []
  paid: []
}>()

const { t } = useI18n()
const { startCheckout } = useDeposit()

const loading = ref(false)
const errorMsg = ref('')

const amountLabel = computed(() => formatDepositAmount(props.amount, props.currency))

const onPay = async () => {
  if (loading.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    const { url } = await startCheckout(props.currency)
    // Full-window redirect to Stripe Hosted Checkout; loading stays on until unload.
    window.location.href = url
  } catch (e) {
    loading.value = false
    // 409 = settled in the meantime — the happy path, not an error.
    if ((e as { statusCode?: number }).statusCode === 409) emit('paid')
    else errorMsg.value = t('deposit.cardPay.error')
  }
}
</script>

<template>
  <div class="step">
    <h4 class="step-heading">{{ t('deposit.cardPay.heading') }}</h4>
    <p class="step-intro">{{ t('deposit.cardPay.desc') }}</p>

    <div class="summary">
      <span class="summary-label">{{ t('deposit.payment.amount') }}</span>
      <span class="summary-amount" dir="ltr">{{ amountLabel }}</span>
    </div>

    <div class="secure-note">
      <Icon name="heroicons-solid:lock-closed" class="secure-icon" aria-hidden="true" />
      <span class="secure-text">{{ t('deposit.cardPay.secure') }}</span>
    </div>

    <div v-if="errorMsg" class="error-note" role="alert">
      {{ errorMsg }}
    </div>

    <div class="actions">
      <button type="button" class="app-btn-alt back-btn" :disabled="loading" @click="emit('back')">
        {{ t('deposit.back') }}
      </button>
      <button type="button" class="app-btn pay-btn" :disabled="loading" @click="onPay">
        <Icon v-if="loading" name="mdi:loading" class="spin-icon" aria-hidden="true" />
        {{ loading ? t('deposit.cardPay.redirecting') : t('deposit.cardPay.pay') }}
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

.summary {
  @apply mb-3 flex items-center justify-between rounded-lg border border-app-border bg-app-surface-muted px-4 py-3;
}

.summary-label {
  @apply text-xs text-app-text-muted;
}

.summary-amount {
  @apply font-mono text-lg font-extrabold text-app-primary;
}

.secure-note {
  @apply mb-4 flex items-center gap-2 rounded-lg border border-app-green/25 bg-app-green/5 px-3.5 py-2.5;
}

.secure-icon {
  @apply h-4 w-4 shrink-0 text-app-green;
}

.secure-text {
  @apply text-xs text-app-text;
}

.error-note {
  @apply mb-3 rounded-lg border border-app-red/20 bg-app-red/10 px-3.5 py-2.5 text-sm font-medium text-app-red;
}

.actions {
  @apply flex gap-3;
}

.back-btn {
  @apply w-auto flex-1;
}

.pay-btn {
  @apply w-auto flex-2 items-center gap-2;
}

.spin-icon {
  @apply h-4 w-4 animate-spin;
}
</style>
