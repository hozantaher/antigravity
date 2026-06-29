<script setup lang="ts">
const props = defineProps<{
  amount: number
  currency: string
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()

type Phase = 'counting' | 'done'

const phase = ref<Phase>('counting')
const confettiActive = ref(false)

const amountLabel = computed(() => formatDepositAmount(props.amount, props.currency))

const CONFETTI_COLORS = [
  'var(--color-app-primary)',
  'var(--color-app-green)',
  'var(--color-app-red)',
  'var(--color-app-amber)',
]

const confettiPieces = Array.from({ length: 24 }, (_, i) => ({
  id: i,
  x: 10 + Math.random() * 80,
  delay: Math.random() * 0.6,
  dur: 0.9 + Math.random() * 0.7,
  color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  rot: Math.random() * 360,
  size: 6 + Math.random() * 5,
  round: i % 3 === 0,
}))

useTimeoutFn(() => {
  phase.value = 'done'
  confettiActive.value = true
  useTimeoutFn(() => {
    confettiActive.value = false
  }, 2400)
}, 600)

const FEATURES = [
  { icon: 'heroicons-outline:document-text', key: 'settlement.successFeatures.invoice' },
  { icon: 'heroicons-outline:badge-check', key: 'settlement.successFeatures.complete' },
]
</script>

<template>
  <div class="step">
    <div v-if="confettiActive" class="confetti" aria-hidden="true">
      <div
        v-for="p in confettiPieces"
        :key="p.id"
        class="confetti-piece"
        :class="{ 'is-round': p.round }"
        :style="{
          left: `${p.x}%`,
          width: `${p.size}px`,
          height: `${p.size}px`,
          background: p.color,
          animation: `settlement-confetti-fall ${p.dur}s ${p.delay}s ease-in forwards`,
          transform: `rotate(${p.rot}deg)`,
        }"
      />
    </div>

    <div class="check-wrap" :class="{ 'is-done': phase === 'done' }">
      <Icon name="heroicons-solid:check-circle" class="check-icon" aria-hidden="true" />
    </div>

    <h4 class="step-heading">{{ t('settlement.successTitle') }}</h4>

    <div v-if="amount > 0" class="paid-amount" dir="ltr">{{ amountLabel }}</div>
    <p class="paid-note">{{ t('settlement.successBody') }}</p>

    <div class="feature-tiles">
      <div v-for="f in FEATURES" :key="f.key" class="feature">
        <Icon :name="f.icon" class="feature-icon" aria-hidden="true" />
        <span class="feature-label">{{ t(f.key) }}</span>
      </div>
    </div>

    <div class="actions">
      <button type="button" class="app-btn close-btn" @click="emit('close')">
        {{ t('settlement.close') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.step {
  @apply relative px-1 py-4 text-center;
}

.confetti {
  @apply pointer-events-none absolute inset-0 overflow-hidden;
}

.confetti-piece {
  @apply absolute top-0 rounded-xs;

  &.is-round {
    @apply rounded-full;
  }
}

.check-wrap {
  @apply mx-auto mb-4 flex h-18 w-18 items-center justify-center text-app-primary/40 transition-all duration-300;

  &.is-done {
    @apply text-app-green;
  }
}

.check-icon {
  @apply h-16 w-16;
}

.step-heading {
  @apply text-lg font-extrabold text-app-text-strong;
}

.paid-amount {
  @apply mt-1.5 font-mono text-32 font-extrabold text-app-green;
}

.paid-note {
  @apply mx-auto mt-1 mb-6 max-w-sm text-sm text-app-text-muted;
}

.feature-tiles {
  @apply mb-6 grid grid-cols-2 gap-2 text-left;
}

.feature {
  @apply flex items-center gap-2 rounded-lg border border-app-green/25 bg-app-green/5 px-3 py-2;
}

.feature-icon {
  @apply h-4 w-4 shrink-0 text-app-green;
}

.feature-label {
  @apply text-xs font-semibold text-app-text;
}

.actions {
  @apply flex gap-3;
}

.close-btn {
  @apply w-full;
}
</style>

<style>
/* Keyframes must be global — scoped styles would rename them away from the inline reference. */
@keyframes settlement-confetti-fall {
  0% {
    opacity: 1;
    transform: translateY(-10px) rotate(0deg);
  }

  100% {
    opacity: 0;
    transform: translateY(220px) rotate(360deg);
  }
}
</style>
