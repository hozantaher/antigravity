<script setup lang="ts">
import type { DepositCurrency } from '~/models'

defineProps<{
  loading?: boolean
}>()

const emit = defineEmits<{
  next: [currency: DepositCurrency]
}>()

const { t } = useI18n()

interface CurrencyOption {
  currency: DepositCurrency
  amountLabel: string
  subKey: string
}

const options: CurrencyOption[] = [
  {
    currency: 'CZK',
    amountLabel: formatDepositAmount(DEPOSIT_AMOUNTS.CZK, 'CZK'),
    subKey: 'deposit.currency.czkSub',
  },
  {
    currency: 'EUR',
    amountLabel: formatDepositAmount(DEPOSIT_AMOUNTS.EUR, 'EUR'),
    subKey: 'deposit.currency.eurSub',
  },
]

const selected = ref<DepositCurrency>()

const onContinue = () => {
  if (selected.value) emit('next', selected.value)
}
</script>

<template>
  <div class="step">
    <div class="step-icon" aria-hidden="true">
      <Icon name="heroicons-outline:shield-check" class="step-icon-svg" />
    </div>
    <h4 class="step-heading">{{ t('deposit.currency.heading') }}</h4>
    <p class="step-intro">{{ t('deposit.currency.intro') }}</p>

    <div class="choice-list">
      <button
        v-for="opt in options"
        :key="opt.currency"
        type="button"
        class="choice"
        :class="{ 'is-selected': selected === opt.currency }"
        @click="selected = opt.currency"
      >
        <span class="choice-amount" dir="ltr">{{ opt.amountLabel }}</span>
        <span class="choice-sub">{{ t(opt.subKey) }}</span>
      </button>
    </div>

    <button type="button" class="app-btn continue-btn" :disabled="!selected || loading" @click="onContinue">
      <Icon v-if="loading" name="mdi:loading" class="spin-icon" aria-hidden="true" />
      {{ t('deposit.continue') }}
    </button>
  </div>
</template>

<style scoped>
.step {
  @apply px-1 py-2 text-center;
}

.step-icon {
  @apply mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-app-primary/5 text-app-primary;
}

.step-icon-svg {
  @apply h-7 w-7;
}

.step-heading {
  @apply text-lg font-bold text-app-text-strong;
}

.step-intro {
  @apply mx-auto mt-1 mb-6 max-w-sm text-sm text-app-text-muted;
}

.choice-list {
  @apply mb-6 flex flex-col gap-3 sm:flex-row;
}

.choice {
  @apply flex flex-1 cursor-pointer flex-col items-center rounded-xl border-2 border-app-border bg-app-surface px-4 py-5 transition-all duration-150;

  &:hover {
    @apply border-app-primary/60;
  }

  &.is-selected {
    @apply border-app-primary bg-app-primary/5;

    .choice-amount {
      @apply text-app-primary;
    }
  }
}

.choice-amount {
  @apply font-mono text-24 font-extrabold text-app-text-strong;
}

.choice-sub {
  @apply mt-1 text-xs text-app-text-muted;
}

.continue-btn {
  @apply items-center gap-2;
}

.spin-icon {
  @apply h-4 w-4 animate-spin;
}
</style>
