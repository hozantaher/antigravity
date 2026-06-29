<script lang="ts" setup>

import { useToast } from 'vue-toastification'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const toast = useToast()

// ?deposit=1 — ItemBid gate redirect; success/cancelled — return from Stripe Checkout.
const depositQuery = typeof route.query.deposit === 'string' ? route.query.deposit : undefined
const autoOpenDeposit = depositQuery === '1' || depositQuery === 'success' || depositQuery === 'cancelled'
const depositIntent = depositQuery === 'success' ? ('verify' as const) : undefined

onMounted(() => {
  if (!depositQuery) return
  const { deposit: _stripped, ...rest } = route.query
  void router.replace({ query: rest })
  if (depositQuery === 'cancelled') toast.warning(t('deposit.return.cancelled'))
})

const { minLengthValidator } = useValidators()

const values = computed(() => [
  { name: 'companyName', title: t('companyName'), required: true, validators: [minLengthValidator(5)] },
  { name: 'companyIdNumber', title: t('ICO'), required: false, validators: [minLengthValidator(5)] },
  { name: 'companyVatNumber', title: t('DIC'), required: false, validators: [minLengthValidator(5)] },
  { name: 'bankAccount', title: t('bankAccount'), required: false },
])

const { invoices, total, page, pageSize, fetchInvoices } = useInvoices()
fetchInvoices()
</script>

<template>
  <div class="billing">
    <div class="intro">
      <h3 class="title">
        {{ t('billingTitle') }}
      </h3>
      <p class="desc">
        {{ t('billingDesc') }}
      </p>
    </div>
    <DepositCard class="deposit-card" :auto-open="autoOpenDeposit" :intent="depositIntent" @paid="fetchInvoices" />

    <div class="section">
      <dl class="defs">
        <ProfileTextValueEdit
          v-for="v in values"
          :key="v.name"
          :name="v.name"
          :title="v.title"
          :required="v.required"
          :validators="v.validators"
        />
        <ProfileAddressEdit />
      </dl>
    </div>

    <Invoices v-model:page="page" class="invoices" :invoices="invoices" :total="total" :page-size="pageSize" />
  </div>
</template>

<style scoped>
.billing {
  @apply mt-10 divide-y divide-app-border;
}

.intro {
  @apply space-y-1;
}

.title {
  @apply text-lg leading-6 font-medium text-app-text-strong;
}

.desc {
  @apply max-w-2xl text-sm text-app-text-muted;
}

.deposit-card {
  @apply mt-6;
}

.section {
  @apply mt-6;
}

.defs {
  @apply divide-y divide-app-border;
}

.invoices {
  @apply pt-12;
}
</style>
