<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import { ModalSize } from '~/models'

const { t } = useI18n()

const { user, emailVerified, changeEmail, sendVerificationEmail } = useUser()
const toast = useToast()
const { emailValidator } = useValidators()

const isOpen = ref(false)
const emailValue = ref()

watch(isOpen, () => {
  emailValue.value = user.value?.email
})

const field = ref()

// Email lives in Firebase: changing it sends a confirmation link and only takes
// effect (and syncs to our DB on next login) after the user confirms.
const save = async () => {
  if (!isFormValid([field])) return

  const err = await changeEmail(emailValue.value)
  if (err) {
    toast.error(t('toastError'))
    return
  }
  toast.success(t('emailSent', { email: emailValue.value }))
  isOpen.value = false
}

const verifyEmail = async () => {
  const err = await sendVerificationEmail()
  if (err) toast.error(t('toastError'))
  else toast.success(t('emailSent', { email: user.value!.email }))
}
</script>

<template>
  <div class="email-row">
    <dt class="term" :class="{ 'is-unverified': !emailVerified }">
      {{ t('email') }}
    </dt>
    <dd class="value">
      <span class="email" :class="{ 'is-unverified': !emailVerified }">
        {{ user?.email }}
      </span>
      <span class="actions">
        <button v-if="!emailVerified" type="button" class="app-link verify-btn" @click="verifyEmail">
          {{ t('sendMeVerificationLink') }}
        </button>
        <BaseModal v-model:is-open="isOpen" :size="ModalSize.Small" :heading="t('email')" is-closable>
          <template #trigger>
            <button type="button" class="app-link" @click="isOpen = true">{{ t('update') }}</button>
          </template>

          <BaseInput
            ref="field"
            v-model:value="emailValue"
            type="text"
            name="email"
            :label="t('email')"
            :validators="[emailValidator()]"
            required
          />

          <div class="modal-actions">
            <button type="button" class="app-btn-alt cancel-btn" @click="isOpen = false">
              {{ t('confirm.cancel') }}
            </button>
            <button type="button" class="app-btn save-btn" @click="save">
              {{ t('saveDetails') }}
            </button>
          </div>
        </BaseModal>
      </span>
    </dd>
  </div>
</template>

<style scoped>
.email-row {
  @apply py-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:py-5;
}

.term {
  @apply text-sm font-medium text-app-text-muted;

  &.is-unverified {
    @apply font-medium text-app-red;
  }
}

.value {
  @apply mt-1 flex text-sm text-app-text-strong sm:col-span-2 sm:mt-0;
}

.email {
  @apply flex-grow;

  &.is-unverified {
    @apply font-bold text-app-red;
  }
}

.actions {
  @apply ml-4 flex flex-shrink flex-wrap justify-end gap-4;
}

.verify-btn {
  @apply text-app-red;
}

.modal-actions {
  @apply flex gap-4;
}

.cancel-btn {
  @apply mt-8;
}

.save-btn {
  @apply mt-8;
}
</style>
