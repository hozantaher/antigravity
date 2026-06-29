<script lang="ts" setup>
import { ensureFirebaseAuth } from '~/features/platform/auth-account/logic/firebaseClient'

useSeoMeta({ robots: 'noindex, nofollow' })
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const localePath = useLocalePath()
const { sendVerificationEmail } = useUser()

type VerifyState = 'verifying' | 'done' | 'invalid'
type ResendStatus = 'idle' | 'sending' | 'sent' | 'error'

const state = ref<VerifyState>('verifying')
const accountEmail = ref('')
// Firebase keeps only the most recent oobCode valid — an older emailed link reads
// as invalid. canResend lets a signed-in user mint a fresh one instead of dead-ending.
const canResend = ref(false)
const resendStatus = ref<ResendStatus>('idle')

// oobCode handling is client-only (Firebase client SDK) — SSR renders the
// 'verifying' placeholder, onMounted resolves the real state.
onMounted(async () => {
  const code = route.query.oobCode
  const auth = await ensureFirebaseAuth()

  if (auth && typeof code === 'string' && code.length > 0) {
    try {
      const { checkActionCode, applyActionCode } = await import('firebase/auth')
      const info = await checkActionCode(auth, code)
      accountEmail.value = info.data.email ?? ''
      await applyActionCode(auth, code)
      if (auth.currentUser) await auth.currentUser.reload().catch(() => {})
      state.value = 'done'
      return
    } catch {
      /* stale/invalid/missing code — fall through to recovery */
    }
  }

  // Recovery: a superseded code still resolves if the account is already verified;
  // otherwise a signed-in user can resend.
  if (auth?.currentUser) {
    await auth.currentUser.reload().catch(() => {})
    accountEmail.value = auth.currentUser.email ?? ''
    if (auth.currentUser.emailVerified) {
      state.value = 'done'
      return
    }
    canResend.value = true
  }
  state.value = 'invalid'
})

const onResend = async () => {
  if (resendStatus.value === 'sending') return
  resendStatus.value = 'sending'
  const err = await sendVerificationEmail()
  resendStatus.value = err ? 'error' : 'sent'
}

const goToLogin = () => router.push(localePath('/sign'))
</script>

<template>
  <section class="app-section">
    <div class="app-container page">
      <main class="main">
        <div class="card-wrap">
          <div class="card">
            <p v-if="state === 'verifying'" class="lead">
              {{ t('authFlow.verifying') }}
            </p>

            <div v-else-if="state === 'done'" class="centered">
              <Icon name="heroicons-outline:check-circle" class="icon is-ok" />
              <h1 class="title">{{ t('authFlow.verifiedTitle') }}</h1>
              <p class="lead">{{ t('authFlow.verifiedBody', { email: accountEmail }) }}</p>
              <button type="button" class="app-btn cta" @click="goToLogin">
                {{ t('authFlow.backToLogin') }}
              </button>
            </div>

            <div v-else class="centered">
              <Icon name="heroicons-outline:exclamation-triangle" class="icon is-warn" />
              <h1 class="title">{{ t('authFlow.pendingTitle') }}</h1>
              <p class="error">{{ t('authFlow.invalidCode') }}</p>

              <p v-if="resendStatus === 'sent'" class="resend-ok">
                {{ t('authFlow.resendSuccess') }}
              </p>
              <p v-else-if="resendStatus === 'error'" class="resend-err">
                {{ t('authFlow.resendError') }}
              </p>

              <div class="actions">
                <button
                  v-if="canResend && resendStatus !== 'sent'"
                  type="button"
                  class="app-btn"
                  :disabled="resendStatus === 'sending'"
                  @click="onResend"
                >
                  {{ resendStatus === 'sending' ? t('authFlow.resending') : t('authFlow.resend') }}
                </button>
                <button type="button" class="app-btn-alt" @click="goToLogin">
                  {{ t('authFlow.backToLogin') }}
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

.main {
  @apply py-8;
}

.card-wrap {
  @apply sm:mx-auto sm:w-full sm:max-w-md;
}

.card {
  @apply rounded-lg border border-app-border bg-app-surface px-4 py-9 text-center sm:px-8;
}

.centered {
  @apply flex flex-col items-center;
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

.title {
  @apply text-lg font-bold text-app-text-strong;
}

.lead {
  @apply mt-2 text-sm text-app-text-muted;
}

.error {
  @apply mt-2 text-sm text-app-red;
}

.resend-ok {
  @apply mt-3 text-sm text-app-green;
}

.resend-err {
  @apply mt-3 text-sm text-app-red;
}

.actions {
  @apply mt-5 flex flex-wrap items-center justify-center gap-3;
}

.cta {
  @apply mt-5;
}
</style>
