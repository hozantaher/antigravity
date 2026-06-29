<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import type { Address, Language, OptionItem } from '~/models'
import type BaseValidator from '~/models/BaseValidator'

const { t, locale } = useI18n()
const toast = useToast()
const router = useRouter()
const localePath = useLocalePath()

useSeo({ title: () => t('createNewAccount'), noindex: true })

const { emailValidator, minLengthValidator, phoneValidator } = useValidators()
const { isLogged, register } = useUser()

const { languages, fetchLanguages } = useLanguages()
const { countries, fetchCountries } = useCountries()
fetchLanguages()
fetchCountries()

const languageOptions = computed(() => languages.value.map<OptionItem>(c => ({ label: c.name, value: c })))
const countryOptions = computed(() => countries.value.map<OptionItem>(c => ({ label: c.name, value: c })))

const loading = ref(false)
const isCompany = ref(false)

const email = ref<string>()
const name = ref<string>()
const companyName = ref<string>()
const companyVatNumber = ref<string>('')
const companyIdNumber = ref<string>('')
const language = ref<Language>()
const address = ref<Address>({} as Address)
const password = ref<string>()
const passwordAgain = ref<string>()
const newsletter = ref<boolean>(true)
const terms = ref<boolean>(false)
const phone = ref<string>()

const fieldEmail = ref()
const fieldName = ref()
const fieldCompanyName = ref()
const fieldCompanyVat = ref()
const fieldCompanyId = ref()
const fieldLanguage = ref()
const fieldCountry = ref()
const fieldAddress = ref()
const fieldCity = ref()
const fieldZip = ref()
const fieldPassword = ref()
const fieldPasswordAgain = ref()
const fieldPhone = ref()

const passwordAgainValidator = computed(
  () =>
    ({
      validator: () => password.value === passwordAgain.value,
      message: t('form.validator.wrongMatch'),
    }) as BaseValidator,
)

if (isLogged.value) router.push(localePath('/'))

watch(isLogged, is => {
  if (is) router?.push(localePath('/profile'))
})

const requiredFields = [
  fieldEmail,
  fieldName,
  fieldLanguage,
  fieldCountry,
  fieldPassword,
  fieldPasswordAgain,
  fieldPhone,
]
const requiredCompanyFields = [fieldCompanyName, fieldCompanyId, fieldCompanyVat, fieldAddress, fieldCity, fieldZip]
const allRequiredFileds = computed(() =>
  isCompany.value ? [...requiredFields, ...requiredCompanyFields] : requiredFields,
)

const create = async () => {
  if (!isFormValid(allRequiredFileds.value)) return

  if (!terms.value) {
    toast.warning(t('termsValidator'))
    return
  }

  loading.value = true

  const err = await register({
    email: email.value!,
    password: password.value!,
    fullName: name.value,
    phone: phone.value,
    language: language.value,
    newsletter: newsletter.value,
    // Country lives on `address` and is required for everyone — always send it;
    // the street/city/zip block is company-only.
    address: address.value,
    ...(isCompany.value
      ? {
          companyName: companyName.value,
          companyVatNumber: companyVatNumber.value,
          companyIdNumber: companyIdNumber.value,
        }
      : {}),
  })

  if (err) toast.error(t(`firebase.${err}`))
  else toast.success(t('accountCreated'))
  loading.value = false
}
</script>

<template>
  <section class="app-section">
    <div class="app-container container-pad">
      <h1 class="app-h1 heading">
        {{ t('createNewAccount') }}
      </h1>
      <main class="main">
        <div class="form-wrap">
          <div class="card">
            <div class="fields">
              <div>
                <BaseInput
                  ref="fieldName"
                  v-model:value="name"
                  type="text"
                  :label="t('name')"
                  :placeholder="t('name')"
                  required
                />
              </div>

              <div>
                <BaseInput
                  ref="fieldEmail"
                  v-model:value="email"
                  type="text"
                  label="E-mail"
                  :placeholder="t('email')"
                  :validators="[emailValidator()]"
                  required
                />
              </div>

              <div>
                <BaseInput
                  ref="fieldPhone"
                  v-model:value="phone"
                  :validators="[phoneValidator()]"
                  type="text"
                  :label="t('phone')"
                  :placeholder="t('phone')"
                  required
                />
              </div>

              <div>
                <BaseCheckbox v-model:value="isCompany" :label="t('registerAsCompany')" />
              </div>

              <div v-if="isCompany" class="company-block">
                <div>
                  <BaseInput
                    ref="fieldCompanyName"
                    v-model:value="companyName"
                    type="text"
                    :label="t('companyName')"
                    :placeholder="t('companyName')"
                    required
                  />
                </div>
                <div class="field-row">
                  <BaseInput
                    ref="fieldCompanyId"
                    v-model:value="companyIdNumber"
                    type="text"
                    :label="t('ICO')"
                    :placeholder="t('ICO')"
                  />
                  <BaseInput
                    ref="fieldCompanyVat"
                    v-model:value="companyVatNumber"
                    type="text"
                    :label="t('DIC')"
                    :placeholder="t('DIC')"
                  />
                </div>
                <div>
                  <BaseInput
                    ref="fieldAddress"
                    v-model:value="address.address"
                    type="text"
                    :label="t('address')"
                    :placeholder="t('address')"
                    required
                  />
                </div>
                <div class="field-row">
                  <BaseInput
                    ref="fieldCity"
                    v-model:value="address.city"
                    type="text"
                    :label="t('city')"
                    :placeholder="t('city')"
                    required
                  />
                  <BaseInput
                    ref="fieldZip"
                    v-model:value="address.zip"
                    type="text"
                    :label="t('PSC')"
                    :placeholder="t('PSC')"
                    required
                  />
                </div>
              </div>

              <div>
                <BaseSelect
                  ref="fieldCountry"
                  v-model:value="address.country"
                  name="country"
                  :options="countryOptions"
                  :label="t('country')"
                  required
                />
              </div>

              <div>
                <BaseSelect
                  ref="fieldLanguage"
                  v-model:value="language"
                  name="language"
                  :options="languageOptions"
                  :label="t('language')"
                  required
                />
              </div>

              <div>
                <BaseInput
                  ref="fieldPassword"
                  v-model:value="password"
                  type="password"
                  :label="t('password')"
                  :placeholder="t('password')"
                  :validators="[minLengthValidator(8)]"
                  required
                />
              </div>
              <div>
                <BaseInput
                  ref="fieldPasswordAgain"
                  v-model:value="passwordAgain"
                  type="password"
                  :label="t('pwAgain')"
                  :placeholder="t('pwAgain')"
                  :validators="[passwordAgainValidator]"
                  required
                />
              </div>

              <div>
                <BaseCheckbox v-model:value="newsletter" :label="t('formNews')" />
                <BaseCheckbox v-model:value="terms" class="terms-check" required>
                  <span class="terms-text">
                    {{ t('formAgree') }}
                    <a class="app-link" :href="getTermsLink(locale)" target="_blank">{{ t('formTerms') }}</a>
                  </span>
                </BaseCheckbox>
              </div>

              <div>
                <button type="button" class="app-btn" :disabled="loading" @click="create">
                  {{ t('createNewAccount') }}
                </button>
              </div>
              <div class="signin-link">
                <NuxtLinkLocale to="/sign" class="app-text-btn">
                  {{ t('alreadyHaveAccount') }}
                </NuxtLinkLocale>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  </section>
</template>

<style scoped>
.container-pad {
  @apply py-8;
}

.heading {
  @apply text-center;
}

.main {
  @apply py-8;
}

.form-wrap {
  @apply sm:mx-auto sm:w-full sm:max-w-md;
}

.card {
  @apply rounded-lg border border-app-border bg-app-surface px-4 py-9 sm:px-8;
}

.fields {
  @apply space-y-6;
}

.company-block {
  @apply -m-2 space-y-6 rounded-lg bg-app-surface-muted p-2 md:-m-4 md:p-4;
}

.field-row {
  @apply flex gap-2;
}

.terms-check {
  @apply mt-3;
}

.terms-text {
  @apply text-sm font-medium text-app-text;
}

.signin-link {
  @apply text-center text-sm;
}
</style>
