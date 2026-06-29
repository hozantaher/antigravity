<script setup lang="ts">
const props = defineProps<{
  itemId: string
  autoOpen?: boolean
  // 'verify' = returned from Stripe Checkout; consumed on the first wizard open.
  intent?: 'verify'
}>()

const emit = defineEmits<{
  settled: []
}>()

const { t } = useI18n()
const { status, isPaid, isPending, isCompleted, fetchStatus } = useSettlement(props.itemId)

const isWizardOpen = ref(false)
const pendingIntent = ref(props.intent)

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

const amountDueLabel = computed(() => formatPrice(status.value?.amountDue))
</script>

<template>
  <div>
    <div v-if="isCompleted || isPaid" class="card is-paid">
      <div class="badge is-paid">
        <Icon name="heroicons-solid:check-circle" class="badge-icon" aria-hidden="true" />
      </div>
      <div class="card-main">
        <h3 class="card-title">{{ t('settlement.card.paidTitle') }}</h3>
        <p class="card-desc">{{ t('settlement.card.paidDesc') }}</p>
      </div>
    </div>

    <div v-else-if="isPending" class="card is-pending">
      <div class="badge is-pending">
        <Icon name="heroicons-outline:clock" class="badge-icon" aria-hidden="true" />
      </div>
      <div class="card-main">
        <h3 class="card-title">{{ t('settlement.card.pendingTitle') }}</h3>
        <p class="card-desc">{{ t('settlement.card.pendingDesc', { amount: amountDueLabel }) }}</p>
      </div>
      <button type="button" class="app-btn card-btn" @click="isWizardOpen = true">
        {{ t('settlement.card.showDetails') }}
      </button>
    </div>

    <div v-else class="card">
      <div class="badge">
        <Icon name="heroicons-solid:trophy" class="badge-icon" aria-hidden="true" />
      </div>
      <div class="card-main">
        <h3 class="card-title">{{ t('settlement.cardTitle') }}</h3>
        <p class="card-desc">{{ t('settlement.card.dueDesc', { amount: amountDueLabel }) }}</p>
      </div>
      <button type="button" class="app-btn card-btn" @click="isWizardOpen = true">
        {{ t('settlement.card.cta') }}
      </button>
    </div>

    <SettlementWizard
      v-model:is-open="isWizardOpen"
      :item-id="itemId"
      :initial-intent="pendingIntent"
      @settled="emit('settled')"
    />
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

.card-btn {
  @apply w-auto shrink-0 self-start whitespace-nowrap sm:self-center;
}
</style>
