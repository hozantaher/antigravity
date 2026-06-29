<script setup lang="ts">
defineProps<{
  loading?: boolean
}>()

const emit = defineEmits<{
  next: [method: 'card' | 'transfer']
  back: []
}>()

const { t } = useI18n()

interface MethodOption {
  method: 'card' | 'transfer'
  icon: string
  titleKey: string
  hintKey: string
}

const options: MethodOption[] = [
  {
    method: 'card',
    icon: 'heroicons-outline:credit-card',
    titleKey: 'settlement.methodCard',
    hintKey: 'settlement.methodCardHint',
  },
  {
    method: 'transfer',
    icon: 'heroicons-outline:library',
    titleKey: 'settlement.methodTransfer',
    hintKey: 'settlement.methodTransferHint',
  },
]

const selected = ref<'card' | 'transfer'>()

const onContinue = () => {
  if (selected.value) emit('next', selected.value)
}
</script>

<template>
  <div class="step">
    <h4 class="step-heading">{{ t('settlement.methodHeading') }}</h4>
    <p class="step-intro">{{ t('settlement.methodIntro') }}</p>

    <div class="choice-list">
      <button
        v-for="opt in options"
        :key="opt.method"
        type="button"
        class="choice"
        :class="{ 'is-selected': selected === opt.method }"
        @click="selected = opt.method"
      >
        <span class="choice-icon" :class="{ 'is-selected': selected === opt.method }">
          <Icon :name="opt.icon" class="choice-icon-svg" aria-hidden="true" />
        </span>
        <span class="choice-main">
          <span class="choice-title">{{ t(opt.titleKey) }}</span>
          <span class="choice-hint">{{ t(opt.hintKey) }}</span>
        </span>
        <span class="choice-radio" :class="{ 'is-selected': selected === opt.method }" aria-hidden="true" />
      </button>
    </div>

    <div class="actions">
      <button type="button" class="app-btn-alt back-btn" :disabled="loading" @click="emit('back')">
        {{ t('settlement.back') }}
      </button>
      <button type="button" class="app-btn next-btn" :disabled="!selected || loading" @click="onContinue">
        <Icon v-if="loading" name="mdi:loading" class="spin-icon" aria-hidden="true" />
        {{ t('settlement.continue') }}
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

.choice-list {
  @apply mb-6 flex flex-col gap-3;
}

.choice {
  @apply flex w-full cursor-pointer items-center gap-3 rounded-xl border-2 border-app-border bg-app-surface px-4 py-3.5 text-left transition-all duration-150;

  &:hover {
    @apply border-app-primary/60;
  }

  &.is-selected {
    @apply border-app-primary bg-app-primary/5;
  }
}

.choice-icon {
  @apply flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-app-surface-muted text-app-text-muted transition-colors;

  &.is-selected {
    @apply bg-app-primary/10 text-app-primary;
  }
}

.choice-icon-svg {
  @apply h-5 w-5;
}

.choice-main {
  @apply flex min-w-0 flex-1 flex-col;
}

.choice-title {
  @apply text-sm font-semibold text-app-text-strong;
}

.choice-hint {
  @apply text-xs text-app-text-muted;
}

.choice-radio {
  @apply h-4.5 w-4.5 shrink-0 rounded-full border-2 border-app-border-strong transition-all;

  &.is-selected {
    @apply border-5 border-app-primary;
  }
}

.actions {
  @apply flex gap-3;
}

.back-btn {
  @apply w-auto flex-1;
}

.next-btn {
  @apply w-auto flex-2 items-center gap-2;
}

.spin-icon {
  @apply h-4 w-4 animate-spin;
}
</style>
