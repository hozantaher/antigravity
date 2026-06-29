<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import { ModalSize } from '~/models'
import type { OptionItem } from '~/models'

const { user, updateProfile } = useUser()
const toast = useToast()
const { t } = useI18n()
const { countries, findCountryByCode2 } = useCountries()

const isOpen = ref(false)
const addressValue = ref<any>({})

const countryOptions = computed(() => countries.value.map<OptionItem>(c => ({ label: c.name, value: c.code2 })))

watch(isOpen, () => {
  addressValue.value = { ...user.value?.address }
})

const countryValue = computed({
  get: () => countryOptions.value.find((c: OptionItem<string>) => c.value === addressValue.value.country?.code2)?.value,
  set: (code2: string) => (addressValue.value.country = findCountryByCode2(code2)),
})

const fieldAddress = ref()
const fieldCity = ref()
const fieldZip = ref()
const fieldCountry = ref()

const save = async () => {
  if (!isFormValid([fieldAddress, fieldCity, fieldZip, fieldCountry])) return

  if (await updateProfile({ address: addressValue.value })) {
    toast.success(t('toastDetailsSaved'))
    isOpen.value = false
  } else {
    toast.error(t('toastError'))
  }
}
</script>

<template>
  <div class="field-row">
    <dt
      class="label"
      :class="{
        'is-required': !user?.address?.address || !user?.address?.city || !user?.address?.zip,
      }"
    >
      {{ t('address') }}
    </dt>
    <dd class="value">
      <span v-if="user?.address" class="value-text">
        {{ user!.address.address ?? '---' }}<br />
        {{ user!.address.city ?? '---' }}, {{ user!.address.zip ?? '---' }}, <br />
        {{ user!.address.country.name }}
      </span>
      <span class="value-action">
        <BaseModal v-model:is-open="isOpen" :size="ModalSize.Small" :heading="t('address')" is-closable>
          <template #trigger>
            <button type="button" class="app-link" @click="isOpen = true">{{ t('update') }}</button>
          </template>

          <BaseInput
            ref="fieldAddress"
            v-model:value="addressValue.address"
            :label="t('address')"
            type="text"
            required
          />
          <BaseInput
            ref="fieldCity"
            v-model:value="addressValue.city"
            :label="t('city')"
            class="input-spaced"
            type="text"
            required
          />
          <BaseInput
            ref="fieldZip"
            v-model:value="addressValue.zip"
            :label="t('PSC')"
            class="input-spaced"
            type="text"
            required
          />
          <BaseSelect
            ref="fieldCountry"
            v-model:value="countryValue"
            class="input-spaced"
            placeholder="Choose country"
            name="country"
            :options="countryOptions"
            :label="t('country')"
            required
          />

          <div class="actions">
            <button type="button" class="app-btn-alt action-btn" @click="isOpen = false">
              {{ t('confirm.cancel') }}
            </button>
            <button type="button" class="app-btn action-btn" @click="save">
              {{ t('saveDetails') }}
            </button>
          </div>
        </BaseModal>
      </span>
    </dd>
  </div>
</template>

<style scoped>
.field-row {
  @apply py-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:py-5;
}

.label {
  @apply text-sm font-medium text-app-text-muted;

  &.is-required {
    @apply font-medium text-app-red;
  }
}

.value {
  @apply mt-1 flex text-sm text-app-text-strong sm:col-span-2 sm:mt-0;
}

.value-text {
  @apply flex-grow;
}

.value-action {
  @apply ml-4 flex-shrink;
}

.input-spaced {
  @apply mt-4;
}

.actions {
  @apply flex gap-4;
}

.action-btn {
  @apply mt-8;
}
</style>
