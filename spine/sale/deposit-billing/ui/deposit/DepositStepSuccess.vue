<script setup lang="ts">
const props = defineProps<{
  amount: number
  currency: string
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const { backlink } = useUser()

type Phase = 'counting' | 'done'

const phase = ref<Phase>('counting')
const progress = ref(0)
const confettiActive = ref(false)

const amountLabel = computed(() => formatDepositAmount(props.amount, props.currency))

// Stroke drawn from 12 o'clock via -90° rotation, so dash-offset fills from the top.
const RING_RADIUS = 28
const RING_CIRC = 2 * Math.PI * RING_RADIUS
const ringOffset = computed(() => RING_CIRC * (1 - progress.value))
const progressPct = computed(() => Math.round(progress.value * 100))

const FEATURES = [
  { icon: 'heroicons-outline:lightning-bolt', key: 'deposit.success.features.bidding' },
  { icon: 'heroicons-outline:refresh', key: 'deposit.success.features.refundable' },
  { icon: 'heroicons-outline:document-text', key: 'deposit.success.features.invoice' },
  { icon: 'heroicons-outline:badge-check', key: 'deposit.success.features.instant' },
]

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

const DURATION_MS = 1400

let startTime = 0
const raf = useRafFn(
  ({ timestamp }) => {
    const p = Math.min((timestamp - startTime) / DURATION_MS, 1)
    progress.value = p
    if (p >= 1) {
      raf.pause()
      phase.value = 'done'
      confettiActive.value = true
      useTimeoutFn(() => {
        confettiActive.value = false
      }, 2400)
    }
  },
  { immediate: false },
)

useTimeoutFn(() => {
  startTime = performance.now()
  raf.resume()
}, 300)

const goBack = async () => {
  const target = backlink.value
  backlink.value = undefined
  emit('close')
  await navigateTo(target ?? '/')
}
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
          animation: `deposit-confetti-fall ${p.dur}s ${p.delay}s ease-in forwards`,
          transform: `rotate(${p.rot}deg)`,
        }"
      />
    </div>

    <div class="gauge-wrap">
      <svg width="72" height="72" viewBox="0 0 72 72" class="gauge" fill="none">
        <circle cx="36" cy="36" :r="RING_RADIUS" stroke="var(--color-app-border)" stroke-width="4" />
        <circle
          cx="36"
          cy="36"
          :r="RING_RADIUS"
          :stroke="phase === 'done' ? 'var(--color-app-green)' : 'var(--color-app-primary)'"
          stroke-width="4"
          stroke-linecap="round"
          :stroke-dasharray="RING_CIRC"
          :stroke-dashoffset="ringOffset"
          class="gauge-progress"
        />
      </svg>
      <div class="gauge-icon" :class="{ 'is-done': phase === 'done' }">
        <Icon
          :name="phase === 'done' ? 'heroicons-solid:lock-open' : 'heroicons-solid:lock-closed'"
          class="gauge-icon-svg"
          aria-hidden="true"
        />
      </div>
    </div>

    <h4 class="step-heading">
      {{ phase === 'done' ? t('deposit.success.title') : t('deposit.success.processing') }}
    </h4>

    <div v-if="phase !== 'done'" class="progress-wrap">
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: `${progressPct}%` }" />
      </div>
      <div class="progress-pct" dir="ltr">{{ progressPct }} %</div>
    </div>

    <template v-if="phase === 'done'">
      <div class="paid-amount" dir="ltr">{{ amountLabel }}</div>
      <p class="paid-note">{{ t('deposit.success.note') }}</p>

      <div class="feature-tiles">
        <div v-for="f in FEATURES" :key="f.key" class="feature">
          <Icon :name="f.icon" class="feature-icon" aria-hidden="true" />
          <span class="feature-label">{{ t(f.key) }}</span>
        </div>
      </div>

      <div class="actions">
        <button type="button" class="app-btn primary-btn" @click="goBack">
          {{ backlink ? t('deposit.success.back') : t('deposit.success.browse') }}
        </button>
        <button type="button" class="app-btn-alt close-btn" @click="emit('close')">
          {{ t('deposit.success.close') }}
        </button>
      </div>
    </template>
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

.gauge-wrap {
  @apply relative mx-auto mb-4 h-18 w-18;
}

.gauge {
  @apply absolute top-0 left-0;
}

.gauge-progress {
  transform-origin: 36px 36px;
  transform: rotate(-90deg);
  transition:
    stroke-dashoffset 0.05s linear,
    stroke 0.3s;
}

.gauge-icon {
  @apply absolute inset-0 flex items-center justify-center text-app-primary transition-all duration-300;

  &.is-done {
    @apply text-app-green;

    .gauge-icon-svg {
      @apply h-8 w-8;
    }
  }
}

.gauge-icon-svg {
  @apply h-6 w-6 transition-all duration-300;
}

.step-heading {
  @apply text-lg font-extrabold text-app-text-strong;
}

.progress-wrap {
  @apply mx-auto mt-3 max-w-52;
}

.progress-track {
  @apply h-1.5 overflow-hidden rounded-full bg-app-border;
}

.progress-fill {
  @apply h-full rounded-full bg-gradient-to-r from-app-primary to-app-green transition-all duration-75;
}

.progress-pct {
  @apply mt-1.5 text-xs text-app-text-muted;
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

.primary-btn {
  @apply w-auto flex-2;
}

.close-btn {
  @apply w-auto flex-1;
}
</style>

<style>
/* Keyframes must be global — scoped styles would rename them away from the inline
   animation reference on the confetti pieces. */
@keyframes deposit-confetti-fall {
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
