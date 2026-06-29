<script setup lang="ts">
import { DEPOSIT_AMOUNTS } from '~/models'
import type { DepositBankDetails } from '~/models'

const stepperLabels = ['Currency', 'Details', 'Payment', 'Done']
const stepperStep = ref(1)

const verifyingSlow = ref(false)
const successKey = ref(0)
const wizardOpen = ref(false)

const bankDetails: DepositBankDetails = {
  iban: 'CZ6520100000002903525501',
  accountNumber: '2903525501/2010',
  recipient: 'Auction24 s.r.o.',
  vs: '1234567890',
  amount: DEPOSIT_AMOUNTS.CZK,
  currency: 'CZK',
  spayd: 'SPD*1.0*ACC:CZ6520100000002903525501*AM:10000.00*CC:CZK*X-VS:1234567890*MSG:KAUCE AUCTION24',
  invoiceUrl: '#',
}
</script>

<template>
  <PlaygroundSection id="deposit" title="Deposit flow" subtitle="Wizard steps, stepper & status card.">
    <PlaygroundSpecimen name="DepositStepper" tag="deposit" surface="white" :chips="['labels', 'step']">
      <DepositStepper :labels="stepperLabels" :step="stepperStep" />
      <template #controls>
        <div class="pg-ctl">
          <span class="pg-ctl-label">step: {{ stepperStep }}</span>
          <input v-model.number="stepperStep" type="range" min="0" :max="stepperLabels.length - 1" class="pg-range" />
        </div>
      </template>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="DepositStepCurrency" tag="deposit · step" surface="white" :chips="['loading', 'next']">
      <div class="pg-wizard-frame">
        <DepositStepCurrency />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="DepositStepBilling" tag="deposit · step" surface="white" :chips="['back', 'next']">
      <div class="pg-wizard-frame">
        <DepositStepBilling />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="DepositStepMethod"
      tag="deposit · step"
      surface="white"
      :chips="['loading', 'back', 'next']"
    >
      <div class="pg-wizard-frame">
        <DepositStepMethod />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="DepositStepCard" tag="deposit · step" surface="white" :chips="['currency', 'amount']">
      <div class="pg-wizard-frame">
        <DepositStepCard currency="CZK" :amount="DEPOSIT_AMOUNTS.CZK" />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="DepositStepPayment"
      tag="deposit · step"
      surface="white"
      :chips="['details', 'error']"
      description="Bank details + live SPAYD QR (mock data)."
    >
      <div class="pg-wizard-frame">
        <DepositStepPayment :details="bankDetails" />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="DepositStepVerifying" tag="deposit · step" surface="white" :chips="['slow']">
      <div class="pg-wizard-frame">
        <DepositStepVerifying :slow="verifyingSlow" />
      </div>
      <template #controls>
        <BaseCheckbox v-model:value="verifyingSlow" label="slow" />
      </template>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="DepositStepSuccess"
      tag="deposit · step"
      surface="white"
      :chips="['amount', 'currency', 'close']"
      description="Animated gauge + confetti."
    >
      <div class="pg-wizard-frame">
        <DepositStepSuccess :key="successKey" :amount="DEPOSIT_AMOUNTS.CZK" currency="CZK" />
      </div>
      <template #controls>
        <button type="button" class="app-btn-alt pg-btn" @click="successKey++">Replay animation</button>
      </template>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="DepositCard"
      tag="deposit"
      surface="white"
      :chips="['autoOpen', 'intent', 'paid']"
      description="Status card — paid / pending / unpaid from useDeposit; opens the wizard."
    >
      <DepositCard />
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="DepositWizard"
      tag="deposit"
      surface="white"
      center
      :chips="['isOpen', 'initialIntent', 'paid']"
      description="Full multi-step modal flow (live — hits the deposit API)."
    >
      <button type="button" class="app-btn pg-btn" @click="wizardOpen = true">Open wizard</button>
      <DepositWizard v-model:is-open="wizardOpen" />
    </PlaygroundSpecimen>
  </PlaygroundSection>
</template>

<style scoped>
.pg-wizard-frame {
  @apply mx-auto max-w-md rounded-xl border border-gray-200 p-5;
}

.pg-ctl {
  @apply flex flex-col gap-1;
}

.pg-ctl-label {
  @apply font-mono text-xs text-gray-400;
}

.pg-range {
  @apply w-40 cursor-pointer;
}

.pg-btn {
  @apply w-auto;
}
</style>
