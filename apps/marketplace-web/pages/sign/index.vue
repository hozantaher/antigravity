<script lang="ts" setup>
import { useToast } from 'vue-toastification'

const { isLogged, signWithCredentials, signWithGoogle, signWithFacebook, backlink } = useUser()
const router = useRouter()
const { t } = useI18n()
const toast = useToast()
const localePath = useLocalePath()

useSeo({ title: () => t('signIn'), noindex: true })

if (isLogged.value) {
  router.push(backlink.value ?? localePath('/'))
  backlink.value = undefined
}

const loading = ref(false)

watch(isLogged, is => {
  if (is) {
    router.push(backlink.value ?? localePath('/'))
    backlink.value = undefined
    loading.value = false
  }
})

const email = ref('')
const password = ref('')

const fieldEmail = ref()
const fieldPassword = ref()

const sign = async () => {
  if (!isFormValid([fieldEmail, fieldPassword])) return

  loading.value = true
  const err = await signWithCredentials(email.value, password.value)

  if (err) {
    toast.error(t(`firebase.${err}`))
    loading.value = false
  }
}

// Google/Facebook were already implemented in useUser (Firebase popup) but never surfaced. Same
// error contract as credentials: an error code string toasts firebase.*, success rides watch(isLogged).
const signSocial = async (provider: 'google' | 'facebook') => {
  loading.value = true
  const err = provider === 'google' ? await signWithGoogle() : await signWithFacebook()
  if (err) {
    toast.error(t(`firebase.${err}`))
    loading.value = false
  }
}
</script>

<template>
  <section class="app-section">
    <div class="app-container page">
      <h1 class="app-h1 heading">
        {{ t('signIn') }}
      </h1>
      <main class="main">
        <div class="card-wrap">
          <div class="card">
            <div class="fields">
              <div>
                <BaseInput
                  ref="fieldEmail"
                  v-model:value="email"
                  type="email"
                  :label="t('email')"
                  :placeholder="t('email')"
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
                  required
                  @keyup.enter="sign"
                />
              </div>
              <div>
                <button type="button" class="app-btn" :disabled="loading" @click="sign">
                  {{ t('login') }}
                </button>
              </div>
              <div class="divider">
                <span class="divider-line" />
                <span class="divider-text">{{ t('orSeparator') }}</span>
                <span class="divider-line" />
              </div>
              <div class="social">
                <button type="button" class="app-btn-alt social-btn" :disabled="loading" @click="signSocial('google')">
                  <Icon name="cib:google" class="social-icon" />
                  <span>{{ t('continueWith', { provider: 'Google' }) }}</span>
                </button>
                <button
                  type="button"
                  class="app-btn-alt social-btn"
                  :disabled="loading"
                  @click="signSocial('facebook')"
                >
                  <Icon name="cib:facebook" class="social-icon" />
                  <span>{{ t('continueWith', { provider: 'Facebook' }) }}</span>
                </button>
              </div>
              <div class="links">
                <NuxtLinkLocale to="/sign/reset-password" class="app-text-btn">
                  {{ t('resetPassword') }}
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

.divider {
  @apply flex items-center gap-3;
}

.divider-line {
  @apply h-px flex-1 bg-app-border;
}

.divider-text {
  @apply text-sm text-app-text-muted;
}

.social {
  @apply space-y-3;
}

.social-btn {
  @apply inline-flex items-center justify-center gap-2;
}

.social-icon {
  @apply h-5 w-5;
}
</style>
