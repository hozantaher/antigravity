<script setup lang="ts">
import { ModalSize } from '~/models'
import type { SettlementBankDetails } from '~/models'

const props = defineProps<{
  isOpen: boolean
  itemId: string
  // 'verify' = the user just returned from Stripe Checkout — show the verifying screen and fast-poll
  // until the webhook settles the payment.
  initialIntent?: 'verify'
}>()

const emit = defineEmits<{
  'update:isOpen': [value: boolean]
  settled: []
}>()

const { t } = useI18n()
const { user, init } = useUser()
const { status, fetchStatus, startTransfer, startCheckout } = useSettlement(props.itemId)
const stripeEnabled = Boolean(useRuntimeConfig().public.stripeEnabled)

const isOpenLocal = computed({
  get: () => props.isOpen,
  set: (value: boolean) => emit('update:isOpen', value),
})

type Step = 'summary' | 'billing' | 'method' | 'card' | 'payment' | 'verifying' | 'success'

const step = ref<Step>('summary')
const details = shallowRef<SettlementBankDetails | null>(null)
const loading = ref(false)
const errorMsg = ref('')
const methodBackTarget = ref<'summary' | 'billing'>('summary')
const verifyPolls = ref(0)

const amountDue = computed(() => status.value?.amountDue?.amount ?? 0)
const currency = computed(() => status.value?.amountDue?.currency?.code ?? '')

const stepperLabels = computed(() => {
  const labels = [t('settlement.steps.summary')]
  labels.push(t('settlement.steps.billing'))
  if (stripeEnabled) labels.push(t('settlement.steps.method'))
  labels.push(t('settlement.steps.payment'), t('settlement.steps.success'))
  return labels
})

const stepIndex = computed(() => {
  const map: Record<Step, number> = stripeEnabled
    ? { summary: 0, billing: 1, method: 2, card: 3, payment: 3, verifying: 4, success: 4 }
    : { summary: 0, billing: 1, method: 2, card: 2, payment: 2, verifying: 3, success: 3 }
  return map[step.value]
})

const showStepper = computed(() => step.value !== 'success' && step.value !== 'verifying')

const hasCompleteAddress = computed(() => {
  const a = user.value?.address
  return !!(a?.address && a?.city && a?.zip && a?.country)
})

const showSuccess = async () => {
  await fetchStatus()
  step.value = 'success'
  await init()
  emit('settled')
}

// The summary CTA. When amountDue === 0 the transfer call settles internally and returns 'completed'.
const requestTransfer = async () => {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await startTransfer()
    if (res.state === 'completed') {
      await showSuccess()
    } else if (res.bank) {
      details.value = res.bank
      step.value = 'payment'
    } else {
      step.value = 'payment'
    }
  } catch (e) {
    // 409 = settled in the meantime (cron/webhook beat the wizard) — happy path.
    if ((e as { statusCode?: number }).statusCode === 409) {
      await showSuccess()
    } else {
      errorMsg.value = t('settlement.toastError')
      step.value = 'payment'
    }
  } finally {
    loading.value = false
  }
}

const afterDetails = async () => {
  if (stripeEnabled) step.value = 'method'
  else await requestTransfer()
}

const onSummaryNext = async () => {
  if (hasCompleteAddress.value) {
    methodBackTarget.value = 'summary'
    await afterDetails()
  } else {
    step.value = 'billing'
  }
}

const onBillingNext = async () => {
  methodBackTarget.value = 'billing'
  await afterDetails()
}

const onMethodNext = async (method: 'card' | 'transfer') => {
  if (method === 'card') step.value = 'card'
  else await requestTransfer()
}

const startCardCheckout = async () => {
  const { url } = await startCheckout()
  window.location.href = url
}

const backFromPayment = () => {
  step.value = stripeEnabled ? 'method' : 'summary'
}

watch(isOpenLocal, async open => {
  if (!open) {
    step.value = 'summary'
    return
  }
  details.value = null
  errorMsg.value = ''
  verifyPolls.value = 0
  if (props.initialIntent === 'verify') {
    step.value = 'verifying'
    void fetchStatus()
    return
  }
  await fetchStatus()
  if (status.value?.state === 'paid' || status.value?.state === 'completed') {
    step.value = 'success'
  } else if (status.value?.state === 'pending') {
    details.value = status.value.bank ?? null
    methodBackTarget.value = 'summary'
    step.value = stripeEnabled ? 'method' : 'payment'
  } else {
    step.value = 'summary'
  }
})

const pollMs = computed(() => (step.value === 'verifying' && verifyPolls.value < 12 ? 2_500 : 10_000))
const verifySlow = computed(() => step.value === 'verifying' && verifyPolls.value >= 12)

const poll = useIntervalFn(
  async () => {
    if (step.value === 'verifying') verifyPolls.value++
    const s = await fetchStatus()
    if (s?.state === 'paid' || s?.state === 'completed') {
      poll.pause()
      await showSuccess()
    }
  },
  pollMs,
  { immediate: false },
)

watch(
  [isOpenLocal, step, errorMsg],
  ([open, s, err]) => {
    if (open && ((s === 'payment' && !err) || s === 'verifying')) poll.resume()
    else poll.pause()
  },
  { immediate: true },
)
</script>

<template>
  <BaseModal v-model:is-open="isOpenLocal" is-closable :size="ModalSize.Wizard">
    <template #heading>
      <div class="wizard-head" :class="{ 'is-bare': !showStepper }">
        <h3 class="wizard-title">{{ t('settlement.title') }}</h3>
        <BaseStepper v-if="showStepper" :labels="stepperLabels" :step="stepIndex" />
      </div>
    </template>

    <Transition name="step" mode="out-in">
      <SettlementStepSuccess
        v-if="step === 'success'"
        :amount="amountDue"
        :currency="currency"
        @close="isOpenLocal = false"
      />
      <SettlementStepVerifying v-else-if="step === 'verifying'" :slow="verifySlow" />
      <SettlementStepSummary
        v-else-if="step === 'summary'"
        :settlement="status"
        :loading="loading"
        @next="onSummaryNext"
      />
      <SettlementStepBilling v-else-if="step === 'billing'" @back="step = 'summary'" @next="onBillingNext" />
      <SettlementStepMethod
        v-else-if="step === 'method'"
        :loading="loading"
        @back="step = methodBackTarget"
        @next="onMethodNext"
      />
      <SettlementStepCard
        v-else-if="step === 'card'"
        :amount="amountDue"
        :currency="currency"
        @back="step = 'method'"
        @paid="showSuccess"
        @checkout="startCardCheckout"
      />
      <SettlementStepPayment v-else :details="details" :error="errorMsg" @back="backFromPayment" />
    </Transition>
  </BaseModal>
</template>

<style scoped>
.wizard-head {
  @apply border-b border-app-border pb-4;

  &.is-bare {
    @apply border-b-0 pb-0;
  }
}

.wizard-title {
  @apply text-lg leading-6 font-medium text-app-text-strong;
}

.step-enter-active,
.step-leave-active {
  @apply transition-all duration-200;
}

.step-enter-from {
  @apply translate-y-2 opacity-0;
}

.step-leave-to {
  @apply -translate-y-1 opacity-0;
}
</style>
