<script setup lang="ts">
import { useToast } from 'vue-toastification'
import type { OptionItem } from '~/models'

const emit = defineEmits<{
  back: []
  next: []
}>()

const { t } = useI18n()
const toast = useToast()
const { user, updateProfile } = useUser()
const { countries, fetchCountries, findCountryByCode2 } = useCountries()
fetchCountries()

const street = ref(user.value?.address?.address ?? '')
const city = ref(user.value?.address?.city ?? '')
const zip = ref(user.value?.address?.zip ?? '')
const countryCode = ref(user.value?.address?.country?.code2 ?? 'cz')

const fieldStreet = ref()
const fieldCity = ref()
const fieldZip = ref()
const fieldCountry = ref()

const countryOptions = computed(() => countries.value.map<OptionItem>(c => ({ label: c.name, value: c.code2 })))

const saving = ref(false)

// Persists the billing address so the Fakturoid invoice carries it.
const onNext = async () => {
  if (!isFormValid([fieldStreet, fieldCity, fieldZip, fieldCountry])) return
  if (!countries.value.length) await fetchCountries()
  const country = findCountryByCode2(countryCode.value)
  if (!country) {
    toast.error(t('settlement.billingError'))
    return
  }

  saving.value = true
  const ok = await updateProfile({
    address: { address: street.value.trim(), city: city.value.trim(), zip: zip.value.trim(), country },
  })
  saving.value = false

  if (!ok) {
    toast.error(t('settlement.billingError'))
    return
  }
  emit('next')
}
</script>

<template>
  <div class="step">
    <h4 class="step-heading">{{ t('settlement.billingHeading') }}</h4>
    <p class="step-intro">{{ t('settlement.billingIntro') }}</p>

    <div class="identity">
      <div class="identity-row">
        <span class="identity-label">{{ t('settlement.billingName') }}</span>
        <span class="identity-value">{{ user?.fullName }}</span>
      </div>
      <div class="identity-row is-last">
        <span class="identity-label">{{ t('settlement.billingEmail') }}</span>
        <span class="identity-value">{{ user?.email }}</span>
      </div>
    </div>

    <div class="form-fields">
      <BaseInput ref="fieldStreet" v-model:value="street" type="text" :label="t('settlement.billingStreet')" required />
      <div class="form-pair">
        <BaseInput ref="fieldZip" v-model:value="zip" type="text" :label="t('settlement.billingZip')" required />
        <BaseInput ref="fieldCity" v-model:value="city" type="text" :label="t('settlement.billingCity')" required />
      </div>
      <BaseSelect
        ref="fieldCountry"
        v-model:value="countryCode"
        :label="t('settlement.billingCountry')"
        :options="countryOptions"
        required
      />
    </div>

    <div class="actions">
      <button type="button" class="app-btn-alt back-btn" :disabled="saving" @click="emit('back')">
        {{ t('settlement.back') }}
      </button>
      <button type="button" class="app-btn next-btn" :disabled="saving" @click="onNext">
        <Icon v-if="saving" name="mdi:loading" class="spin-icon" aria-hidden="true" />
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

.identity {
  @apply mb-4 overflow-hidden rounded-lg border border-app-border bg-app-surface-muted;
}

.identity-row {
  @apply flex items-center justify-between border-b border-app-border px-4 py-2.5;

  &.is-last {
    @apply border-b-0;
  }
}

.identity-label {
  @apply text-xs text-app-text-muted;
}

.identity-value {
  @apply text-sm font-semibold text-app-text-strong;
}

.form-fields {
  @apply mb-6 flex flex-col gap-3;
}

.form-pair {
  @apply grid grid-cols-2 gap-3;
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
