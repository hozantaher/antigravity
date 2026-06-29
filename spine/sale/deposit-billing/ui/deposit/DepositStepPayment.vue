<script setup lang="ts">
import { useToast } from 'vue-toastification'
import type { DepositBankDetails } from '~/models'

const props = defineProps<{
  details: DepositBankDetails | null
  error?: string
}>()

const emit = defineEmits<{
  back: []
}>()

const { t } = useI18n()
const toast = useToast()
const { user } = useUser()
const { copy, isSupported: canCopy } = useClipboard()

const formatIban = (iban: string): string => iban.replace(/(.{4})/g, '$1 ').trim()

// Must mirror the server-built SPAYD message — it's literal payment data, not UI copy.
const messageValue = computed(() => `Kauce ${user.value?.fullName ?? ''}`)

const amountLabel = computed(() =>
  props.details ? formatDepositAmount(props.details.amount, props.details.currency) : '',
)

interface DetailRow {
  label: string
  value: string
  big?: boolean
}

const rows = computed<DetailRow[]>(() => {
  const d = props.details
  if (!d) return []
  return [
    { label: t('deposit.payment.recipient'), value: d.recipient },
    { label: t('deposit.payment.account'), value: d.accountNumber },
    { label: t('deposit.payment.iban'), value: formatIban(d.iban) },
    { label: t('deposit.payment.amount'), value: amountLabel.value, big: true },
    { label: t('deposit.payment.vs'), value: d.vs, big: true },
    { label: t('deposit.payment.message'), value: messageValue.value },
  ]
})

const qrSvg = shallowRef('')

// Dynamic import keeps the qrcode package out of the page chunk until this step renders.
watch(
  () => props.details,
  async d => {
    if (!d) {
      qrSvg.value = ''
      return
    }
    const { default: QRCode } = await import('qrcode')
    qrSvg.value = await QRCode.toString(d.spayd, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
  },
  { immediate: true },
)

const onCopy = async () => {
  const d = props.details
  if (!canCopy.value || !d) return
  const payload = [
    `${t('deposit.payment.account')}: ${d.accountNumber}`,
    `${t('deposit.payment.iban')}: ${d.iban}`,
    `${t('deposit.payment.amount')}: ${amountLabel.value}`,
    `${t('deposit.payment.vs')}: ${d.vs}`,
    `${t('deposit.payment.message')}: ${messageValue.value}`,
  ].join('\n')
  await copy(payload)
  toast.success(t('deposit.payment.copied'))
}
</script>

<template>
  <div class="step">
    <h4 class="step-heading">{{ t('deposit.payment.heading') }}</h4>
    <p class="step-intro">{{ t('deposit.payment.intro') }}</p>

    <template v-if="error">
      <div class="error-note" role="alert">
        {{ error }}
      </div>
      <div class="actions">
        <button type="button" class="app-btn-alt back-btn" @click="emit('back')">
          {{ t('deposit.back') }}
        </button>
      </div>
    </template>

    <template v-else-if="details">
      <div class="pay-grid">
        <div class="pay-rows">
          <div v-for="(row, i) in rows" :key="row.label" class="pay-row" :class="{ 'is-last': i === rows.length - 1 }">
            <span class="pay-label">{{ row.label }}</span>
            <span class="pay-value" :class="{ 'is-big': row.big }" dir="ltr">{{ row.value }}</span>
          </div>
        </div>

        <div class="qr-box">
          <!-- eslint-disable-next-line vue/no-v-html -- SVG comes from the qrcode lib; input is the server-built SPAYD string, not user HTML. -->
          <div class="qr" aria-hidden="true" v-html="qrSvg" />
          <p class="qr-hint">{{ t('deposit.payment.qrHint') }}</p>
        </div>
      </div>

      <div class="waiting" role="status">
        <span class="waiting-dot" aria-hidden="true" />
        <span class="waiting-text">{{ t('deposit.payment.waiting') }}</span>
      </div>

      <div class="vs-note">
        <i18n-t keypath="deposit.payment.note" tag="p">
          <template #vs>
            <strong dir="ltr">{{ details.vs }}</strong>
          </template>
        </i18n-t>
      </div>

      <a v-if="details.invoiceUrl" :href="details.invoiceUrl" target="_blank" class="app-link invoice-link">
        <Icon name="heroicons-outline:document-text" class="invoice-icon" aria-hidden="true" />
        {{ t('deposit.payment.invoice') }}
      </a>

      <div class="actions">
        <button type="button" class="app-btn-alt back-btn" @click="emit('back')">
          {{ t('deposit.back') }}
        </button>
        <button v-if="canCopy" type="button" class="app-btn copy-btn" @click="onCopy">
          <Icon name="heroicons-outline:clipboard-copy" class="copy-icon" aria-hidden="true" />
          {{ t('deposit.payment.copy') }}
        </button>
      </div>
    </template>

    <div v-else class="loading-box">
      <Icon name="mdi:loading" class="loading-icon" aria-hidden="true" />
      {{ t('deposit.payment.loading') }}
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

.pay-grid {
  @apply mb-4 flex flex-col gap-4 sm:flex-row;
}

.pay-rows {
  @apply min-w-0 flex-1 overflow-hidden rounded-lg border border-app-border bg-app-surface-muted;
}

.pay-row {
  @apply flex items-center justify-between gap-3 border-b border-app-border px-3.5 py-2;

  &.is-last {
    @apply border-b-0;
  }
}

.pay-label {
  @apply shrink-0 text-xs text-app-text-muted;
}

.pay-value {
  @apply truncate text-sm font-semibold text-app-text-strong;

  &.is-big {
    @apply font-mono text-base font-extrabold text-app-primary;
  }
}

.qr-box {
  @apply flex shrink-0 flex-row items-center gap-3 sm:w-36 sm:flex-col sm:justify-center;
}

.qr {
  @apply h-28 w-28 shrink-0 rounded-lg border border-app-border bg-app-surface p-1.5;

  :deep(svg) {
    @apply h-full w-full;
  }
}

.qr-hint {
  @apply text-xs text-app-text-muted sm:text-center;
}

.waiting {
  @apply mb-3 flex items-center gap-2.5 rounded-lg border border-app-primary/20 bg-app-primary/5 px-3.5 py-2.5;
}

.waiting-dot {
  @apply h-2.5 w-2.5 shrink-0 animate-ping rounded-full bg-app-primary;
}

.waiting-text {
  @apply text-xs text-app-primary;
}

.vs-note {
  @apply mb-3 rounded-lg border border-app-amber/30 bg-app-amber/10 px-3.5 py-2.5;

  p {
    @apply text-xs leading-normal text-app-amber;
  }

  strong {
    @apply font-bold;
  }
}

.invoice-link {
  @apply mb-4 inline-flex items-center gap-1.5 text-sm;
}

.invoice-icon {
  @apply h-4 w-4;
}

.actions {
  @apply flex gap-3;
}

.back-btn {
  @apply w-auto flex-1;
}

.copy-btn {
  @apply w-auto flex-2 items-center gap-2;
}

.copy-icon {
  @apply h-4 w-4;
}

.error-note {
  @apply mb-4 rounded-lg border border-app-red/20 bg-app-red/10 px-3.5 py-2.5 text-sm font-medium text-app-red;
}

.loading-box {
  @apply flex items-center justify-center gap-2 py-10 text-sm text-app-text-muted;
}

.loading-icon {
  @apply h-5 w-5 animate-spin;
}
</style>
