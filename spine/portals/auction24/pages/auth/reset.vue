<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import { ensureFirebaseAuth } from '~/features/platform/auth-account/logic/firebaseClient'
import type BaseValidator from '~/models/BaseValidator'

useSeoMeta({ robots: 'noindex, nofollow' })
const { t } = useI18n()
const toast = useToast()
const route = useRoute()
const router = useRouter()
const localePath = useLocalePath()
const { minLengthValidator } = useValidators()

type ResetState = 'verifying' | 'form' | 'invalid' | 'done'
const state = ref<ResetState>('verifying')
const accountEmail = ref('')
const loading = ref(false)
let oobCode = ''

const password = ref('')
const passwordAgain = ref('')
const fieldPassword = ref()
const fieldPasswordAgain = ref()

const passwordAgainValidator = computed(
  () =>
    ({
      validator: () => password.value === passwordAgain.value,
      message: t('form.validator.wrongMatch'),
    }) as BaseValidator,
)

// oobCode verification is client-only (Firebase client SDK) — SSR renders the
// 'verifying' placeholder, onMounted resolves the real state.
onMounted(async () => {
  const code = route.query.oobCode
  if (typeof code !== 'string' || code.length === 0) {
    state.value = 'invalid'
    return
  }
  oobCode = code
  const auth = await ensureFirebaseAuth()
  if (!auth) {
    state.value = 'invalid'
    return
  }
  try {
    const { verifyPasswordResetCode } = await import('firebase/auth')
    accountEmail.value = await verifyPasswordResetCode(auth, oobCode)
    state.value = 'form'
  } catch {
    state.value = 'invalid'
  }
})

const submit = async () => {
  if (!isFormValid([fieldPassword, fieldPasswordAgain])) return
  loading.value = true
  try {
    const auth = await ensureFirebaseAuth()
    if (!auth) throw new Error('firebase-unavailable')
    const { confirmPasswordReset } = await import('firebase/auth')
    await confirmPasswordReset(auth, oobCode, password.value)
    state.value = 'done'
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'auth/expired-action-code' || code === 'auth/invalid-action-code') {
      state.value = 'invalid'
    } else {
      toast.error(t('authFlow.resetFailed'))
    }
  } finally {
    loading.value = false
  }
}

const goToLogin = () => router.push(localePath('/sign'))
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
            <p v-if="state === 'verifying'" class="lead">
              {{ t('authFlow.verifying') }}
            </p>

            <div v-else-if="state === 'invalid'" class="centered">
              <Icon name="heroicons-outline:exclamation-triangle" class="icon is-warn" />
              <p class="error">{{ t('authFlow.invalidCode') }}</p>
              <div class="actions">
                <NuxtLinkLocale to="/sign/reset-password" class="app-btn">
                  {{ t('authFlow.getNewResetLink') }}
                </NuxtLinkLocale>
                <button type="button" class="app-btn-alt" @click="goToLogin">
                  {{ t('authFlow.backToLogin') }}
                </button>
              </div>
            </div>

            <div v-else-if="state === 'done'" class="centered">
              <Icon name="heroicons-outline:check-circle" class="icon is-ok" />
              <p class="lead">{{ t('authFlow.resetSuccess') }}</p>
              <button type="button" class="app-btn cta" @click="goToLogin">
                {{ t('authFlow.backToLogin') }}
              </button>
            </div>

            <div v-else class="fields">
              <p class="lead">{{ t('authFlow.resetLead') }}</p>
              <p v-if="accountEmail" class="account">{{ accountEmail }}</p>
              <div>
                <BaseInput
                  ref="fieldPassword"
                  v-model:value="password"
                  type="password"
                  :label="t('authFlow.newPassword')"
                  :placeholder="t('authFlow.newPassword')"
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
                  @keyup.enter="submit"
                />
              </div>
              <div>
                <button type="button" class="app-btn" :disabled="loading" @click="submit">
                  {{ t('authFlow.resetSubmit') }}
                </button>
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

.centered {
  @apply flex flex-col items-center text-center;
}

.icon {
  @apply mb-4 h-12 w-12;

  &.is-ok {
    @apply text-app-green;
  }

  &.is-warn {
    @apply text-app-red;
  }
}

.lead {
  @apply text-sm text-app-text-muted;
}

.account {
  @apply text-center text-sm font-semibold text-app-text-strong;
}

.error {
  @apply mt-2 text-sm text-app-red;
}

.actions {
  @apply mt-5 flex flex-wrap items-center justify-center gap-3;
}

.cta {
  @apply mt-5;
}
</style>
