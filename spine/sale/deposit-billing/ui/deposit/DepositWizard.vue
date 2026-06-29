<script setup lang="ts">
import { ModalSize, depositAmountFor } from '~/models'
import type { DepositBankDetails, DepositCurrency, DepositMethod } from '~/models'

const props = defineProps<{
  isOpen: boolean
  // 'verify' = the user just returned from Stripe Checkout — show the verifying
  // screen and fast-poll until the webhook settles the payment.
  initialIntent?: 'verify'
}>()

const emit = defineEmits<{
  'update:isOpen': [value: boolean]
  paid: []
}>()

const { t } = useI18n()
const { user, init } = useUser()
const { status, fetchStatus, startTransfer } = useDeposit()
const stripeEnabled = Boolean(useRuntimeConfig().public.stripeEnabled)

const isOpenLocal = computed({
  get: () => props.isOpen,
  set: (value: boolean) => emit('update:isOpen', value),
})

type Step = 'currency' | 'billing' | 'method' | 'card' | 'payment' | 'verifying' | 'success'

const step = ref<Step>('currency')
const currency = ref<DepositCurrency>('CZK')
const details = shallowRef<DepositBankDetails | null>(null)
const loading = ref(false)
const errorMsg = ref('')
// Where "back" from the method step lands — currency when billing was skipped.
const methodBackTarget = ref<'currency' | 'billing'>('currency')
const verifyPolls = ref(0)

const cardAmount = computed(() => details.value?.amount ?? depositAmountFor(currency.value))

const stepperLabels = computed(() => {
  const labels = [t('deposit.stepper.currency'), t('deposit.stepper.details')]
  if (stripeEnabled) labels.push(t('deposit.stepper.method'))
  labels.push(t('deposit.stepper.payment'), t('deposit.stepper.done'))
  return labels
})

const stepIndex = computed(() => {
  const map: Record<Step, number> = stripeEnabled
    ? { currency: 0, billing: 1, method: 2, card: 3, payment: 3, verifying: 4, success: 4 }
    : { currency: 0, billing: 1, method: 2, card: 2, payment: 2, verifying: 3, success: 3 }
  return map[step.value]
})

const showStepper = computed(() => step.value !== 'success' && step.value !== 'verifying')

// The settled balance is the truth; `details` only covers the gap until the first
// post-settle status fetch (it can hold the OTHER currency after a cross-currency 409).
const successAmount = computed(() => {
  if (status.value?.state === 'paid' && status.value.paid) return status.value.paid
  if (details.value) return { amount: details.value.amount, currency: details.value.currency as string }
  return { amount: depositAmountFor(currency.value), currency: currency.value as string }
})

const hasCompleteAddress = computed(() => {
  const a = user.value?.address
  return !!(a?.address && a?.city && a?.zip && a?.country)
})

const showSuccess = async () => {
  // Refresh the shared deposit state first — the card-step 409 path arrives here
  // without it, and DepositCard renders from that state after the wizard closes.
  await fetchStatus()
  step.value = 'success'
  await init()
  emit('paid')
}

const requestTransfer = async () => {
  loading.value = true
  errorMsg.value = ''
  try {
    details.value = await startTransfer(currency.value)
    step.value = 'payment'
  } catch (e) {
    // 409 = settled in the meantime (cron beat the wizard) — that's the happy path.
    if ((e as { statusCode?: number }).statusCode === 409) {
      await fetchStatus()
      await showSuccess()
    } else {
      errorMsg.value = t('deposit.payment.error')
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

const onCurrencyNext = async (c: DepositCurrency) => {
  currency.value = c
  // Drop details resumed for a previously pending currency — the card step would
  // otherwise display the stale amount while Stripe charges the new currency.
  details.value = null
  if (hasCompleteAddress.value) {
    methodBackTarget.value = 'currency'
    await afterDetails()
  } else {
    step.value = 'billing'
  }
}

const onBillingNext = async () => {
  methodBackTarget.value = 'billing'
  await afterDetails()
}

const onMethodNext = async (method: DepositMethod) => {
  if (method === 'card') step.value = 'card'
  else await requestTransfer()
}

const backFromPayment = () => {
  step.value = stripeEnabled ? 'method' : 'currency'
}

// Resume where the user left off; an open proforma resumes at the method choice
// (a pending invoice no longer implies transfer intent once cards exist).
watch(isOpenLocal, async open => {
  if (!open) {
    // Reset so the poll watch can't resume against the previous session's step
    // while the next open is still deciding where to land.
    step.value = 'currency'
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
  if (status.value?.state === 'paid') {
    step.value = 'success'
  } else if (status.value?.state === 'pending' && status.value.pending) {
    currency.value = status.value.pending.currency
    details.value = status.value.pending
    methodBackTarget.value = 'currency'
    step.value = stripeEnabled ? 'method' : 'payment'
  } else {
    step.value = 'currency'
  }
})

// One poller for both waiting screens: transfer payment (10 s) and post-checkout
// verifying (2.5 s for the first ~30 s, then 10 s with the slow note).
const pollMs = computed(() => (step.value === 'verifying' && verifyPolls.value < 12 ? 2_500 : 10_000))
const verifySlow = computed(() => step.value === 'verifying' && verifyPolls.value >= 12)

const poll = useIntervalFn(
  async () => {
    if (step.value === 'verifying') verifyPolls.value++
    const s = await fetchStatus()
    if (s?.state === 'paid') {
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
    // No polling behind the transfer-error screen — there is nothing to wait for.
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
        <h3 class="wizard-title">{{ t('deposit.title') }}</h3>
        <BaseStepper v-if="showStepper" :labels="stepperLabels" :step="stepIndex" />
      </div>
    </template>

    <Transition name="step" mode="out-in">
      <DepositStepSuccess
        v-if="step === 'success'"
        :amount="successAmount.amount"
        :currency="successAmount.currency"
        @close="isOpenLocal = false"
      />
      <DepositStepVerifying v-else-if="step === 'verifying'" :slow="verifySlow" />
      <DepositStepCurrency v-else-if="step === 'currency'" :loading="loading" @next="onCurrencyNext" />
      <DepositStepBilling v-else-if="step === 'billing'" @back="step = 'currency'" @next="onBillingNext" />
      <DepositStepMethod
        v-else-if="step === 'method'"
        :loading="loading"
        @back="step = methodBackTarget"
        @next="onMethodNext"
      />
      <DepositStepCard
        v-else-if="step === 'card'"
        :currency="currency"
        :amount="cardAmount"
        @back="step = 'method'"
        @paid="showSuccess"
      />
      <DepositStepPayment v-else :details="details" :error="errorMsg" @back="backFromPayment" />
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
