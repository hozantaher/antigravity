<script lang="ts" setup>
import { useToast } from 'vue-toastification'

const { t, locale } = useI18n()

const toast = useToast()
const { user, removeUser, resetPassword } = useUser()

const { minLengthValidator, phoneValidator } = useValidators()

const values = computed(() => [
  { name: 'fullName', title: t('name'), required: true, validators: [minLengthValidator(5)] },
  { name: 'phone', title: t('phone'), required: true, validators: [phoneValidator()] },
])

const changePassword = async () => {
  const err = await resetPassword(user.value!.email, locale.value)
  if (err) toast.error(t(`firebase.${err}`))
  else toast.success(t('emailSent', { email: user.value!.email }))
}

const remove = async () => {
  await removeUser()
}
</script>

<template>
  <div class="profile">
    <div class="intro">
      <h3 class="intro-title">
        {{ t('accountTitle') }}
      </h3>
      <p class="intro-desc">
        {{ t('accountDesc') }}
      </p>
    </div>
    <div class="account">
      <dl class="account-list">
        <ProfileTextValueEdit
          v-for="v in values"
          :key="v.name"
          :name="v.name"
          :title="v.title"
          :required="v.required"
          :validators="v.validators"
        />

        <ProfileEmailEdit />
        <ProfileLanguageEdit />

        <div class="field-row">
          <dt class="field-term">
            {{ t('password') }}
          </dt>
          <dd class="field-desc">
            <span class="field-value">********</span>
            <span class="field-action">
              <button type="button" class="app-link" @click="changePassword">{{ t('sendMeLinkPassword') }}</button>
            </span>
          </dd>
        </div>
      </dl>
    </div>

    <SavedSearches />

    <div class="panel">
      <div class="panel-body">
        <h3 class="panel-title">
          {{ t('formAgree') }}
        </h3>
        <div class="panel-desc" />
        <div class="panel-link-wrap">
          <a :href="getTermsLink(locale)" target="_blank" class="panel-link"
            >{{ t('formTerms') }}<span aria-hidden="true">&rarr;</span></a
          >
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-body">
        <h3 class="panel-title">
          {{ t('deleteAccount') }}
        </h3>
        <div class="panel-desc">
          <p>{{ t('deleteAccountDesc') }}</p>
        </div>
        <div class="panel-actions">
          <BaseConfirmation @on-confirm="remove">
            <button type="button" class="app-btn-danger delete-btn">
              {{ t('deleteAccount') }}
            </button>
          </BaseConfirmation>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile {
  @apply mt-10 divide-y divide-app-border;
}

.intro {
  @apply space-y-1;
}

.intro-title {
  @apply text-lg leading-6 font-medium text-app-text-strong;
}

.intro-desc {
  @apply max-w-2xl text-sm text-app-text-muted;
}

.account {
  @apply mt-6;
}

.account-list {
  @apply divide-y divide-app-border;
}

.field-row {
  @apply py-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:py-5;
}

.field-term {
  @apply text-sm font-medium text-app-text-muted;
}

.field-desc {
  @apply mt-1 flex text-sm text-app-text-strong sm:col-span-2 sm:mt-0;
}

.field-value {
  @apply flex-grow;
}

.field-action {
  @apply ml-4 flex-shrink-0;
}

.panel {
  @apply mt-8 rounded-lg border border-app-border bg-app-surface;
}

.panel-body {
  @apply px-4 py-5 sm:p-6;
}

.panel-title {
  @apply text-lg leading-6 font-medium text-app-text-strong;
}

.panel-desc {
  @apply mt-2 max-w-xl text-sm text-app-text-muted;
}

.panel-link-wrap {
  @apply mt-3 text-sm;
}

.panel-link {
  @apply font-medium text-app-primary hover:text-app-primary-hover;
}

.panel-actions {
  @apply mt-5;
}

.delete-btn {
  @apply w-auto;
}
</style>
