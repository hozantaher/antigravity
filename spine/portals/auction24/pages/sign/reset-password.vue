<script lang="ts" setup>
import { useToast } from 'vue-toastification'

const { isLogged, resetPassword: requestReset } = useUser()
const router = useRouter()
const { t, locale } = useI18n()
const toast = useToast()
const localePath = useLocalePath()

useSeo({ title: () => t('resetPassword'), noindex: true })

if (isLogged.value) router.push(localePath('/'))

const loading = ref(false)

watch(isLogged, is => {
  if (is) {
    router.push(localePath('/'))
    loading.value = false
  }
})

const email = ref('')

const fieldEmail = ref()

const resetPassword = async () => {
  if (!isFormValid([fieldEmail])) return

  loading.value = true
  const err = await requestReset(email.value, locale.value)
  if (err) toast.error(t(`firebase.${err}`))
  else toast.success(t('authFlow.emailSentReset', { email: email.value }))
  loading.value = false
  if (!err) router.push(localePath('/sign'))
}
</script>

<template>
  <section class="app-section">
    <div class="app-container page">
      <h1 class="app-h1 heading">
        {{ t('resetPassword') }}
      </h1>
      <main class="main">
        <div class="card-wrap">
          <div class="card">
            <div class="fields">
              <div>
                <BaseInput
                  ref="fieldEmail"
                  v-model:value="email"
                  type="text"
                  :label="t('email')"
                  :placeholder="t('email')"
                  required
                />
              </div>

              <div>
                <button type="button" class="app-btn" :disabled="loading" @click="resetPassword">
                  {{ t('resetPassword') }}
                </button>
              </div>
              <div class="links">
                <NuxtLinkLocale to="/sign" class="app-text-btn">
                  {{ t('alreadyHaveAccount') }}
                </NuxtLinkLocale>
                <NuxtLinkLocale to="/sign/up" class="app-text-btn">
                  {{ t('createNewAccount') }}
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
.page {
  @apply py-8;
}

.heading {
  @apply text-center;
}

.main {
  @apply py-8;
}

.card-wrap {
  @apply sm:mx-auto sm:w-full sm:max-w-md;
}

.card {
  @apply rounded-lg border border-app-border bg-app-surface px-4 py-9 sm:px-8;
}

.fields {
  @apply space-y-6;
}

.links {
  @apply flex justify-between text-sm;
}
</style>
