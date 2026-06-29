<script setup lang="ts">
const props = defineProps<{
  autoOpen?: boolean
  // 'verify' = returned from Stripe Checkout; consumed on the first wizard open.
  intent?: 'verify'
}>()

const emit = defineEmits<{
  paid: []
}>()

const { t } = useI18n()
const { status, isPaid, isPending, fetchStatus } = useDeposit()

const isWizardOpen = ref(false)
const pendingIntent = ref(props.intent)

// One-shot: a later manual reopen must not land on the verifying screen again.
watch(isWizardOpen, open => {
  if (!open) pendingIntent.value = undefined
})

onMounted(async () => {
  if (props.autoOpen && props.intent === 'verify') {
    isWizardOpen.value = true
    void fetchStatus()
    return
  }
  await fetchStatus()
  if (props.autoOpen && !isPaid.value) isWizardOpen.value = true
})

// Exempt users (deposit waived by an admin) have state 'paid' with no amount —
// showing a formatted "0 €" would misstate what happened.
const paidLabel = computed(() =>
  status.value?.paid?.amount ? formatDepositAmount(status.value.paid.amount, status.value.paid.currency) : '',
)
const pendingLabel = computed(() =>
  status.value?.pending ? formatDepositAmount(status.value.pending.amount, status.value.pending.currency) : '',
)

const czkLabel = formatDepositAmount(DEPOSIT_AMOUNTS.CZK, 'CZK')
const eurLabel = formatDepositAmount(DEPOSIT_AMOUNTS.EUR, 'EUR')
</script>

<template>
  <div>
    <div v-if="isPaid" class="card is-paid">
      <div class="badge is-paid">
        <Icon name="heroicons-solid:shield-check" class="badge-icon" aria-hidden="true" />
      </div>
      <div class="card-main">
        <h3 class="card-title">{{ t('deposit.card.paidTitle') }}</h3>
        <p class="card-desc">{{ t('deposit.card.paidDesc') }}</p>
      </div>
      <div v-if="paidLabel" class="paid-amount" dir="ltr">{{ paidLabel }}</div>
    </div>

    <div v-else-if="isPending" class="card is-pending">
      <div class="badge is-pending">
        <Icon name="heroicons-outline:clock" class="badge-icon" aria-hidden="true" />
      </div>
      <div class="card-main">
        <h3 class="card-title">{{ t('deposit.card.pendingTitle') }}</h3>
        <p class="card-desc">{{ t('deposit.card.pendingDesc', { amount: pendingLabel }) }}</p>
        <a
          v-if="status?.pending?.invoiceUrl"
          :href="status.pending.invoiceUrl"
          target="_blank"
          class="app-link card-link"
        >
          {{ t('deposit.card.invoice') }}
        </a>
      </div>
      <button type="button" class="app-btn card-btn" @click="isWizardOpen = true">
        {{ t('deposit.card.showDetails') }}
      </button>
    </div>

    <div v-else class="card">
      <div class="badge">
        <Icon name="heroicons-outline:lock-closed" class="badge-icon" aria-hidden="true" />
      </div>
      <div class="card-main">
        <h3 class="card-title">{{ t('deposit.card.title') }}</h3>
        <p class="card-desc">{{ t('deposit.card.desc', { czk: czkLabel, eur: eurLabel }) }}</p>
      </div>
      <button type="button" class="app-btn card-btn" @click="isWizardOpen = true">
        {{ t('deposit.card.cta') }}
      </button>
    </div>

    <DepositWizard v-model:is-open="isWizardOpen" :initial-intent="pendingIntent" @paid="emit('paid')" />
  </div>
</template>

<style scoped>
.card {
  @apply flex flex-col gap-4 rounded-lg border border-app-border bg-app-surface p-5 sm:flex-row sm:items-center;

  &.is-paid {
    @apply border-app-green/30 bg-app-green/5;
  }

  &.is-pending {
    @apply border-app-amber/30 bg-app-amber/10;
  }
}

.badge {
  @apply flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-app-primary/5 text-app-primary;

  &.is-paid {
    @apply bg-app-green/15 text-app-green;
  }

  &.is-pending {
    @apply bg-app-amber/15 text-app-amber;
  }
}

.badge-icon {
  @apply h-6 w-6;
}

.card-main {
  @apply min-w-0 flex-1;
}

.card-title {
  @apply text-base font-semibold text-app-text-strong;
}

.card-desc {
  @apply mt-0.5 text-sm text-app-text-muted;
}

.card-link {
  @apply mt-1 inline-block text-sm;
}

.card-btn {
  @apply w-auto shrink-0 self-start whitespace-nowrap sm:self-center;
}

.paid-amount {
  @apply shrink-0 font-mono text-lg font-extrabold text-app-green;
}
</style>
