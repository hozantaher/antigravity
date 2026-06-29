<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import { ModalSize } from '~/models'
import type { Language, OptionItem } from '~/models'

const { t } = useI18n()

const { user, updateProfile, applyUserLanguage } = useUser()
const toast = useToast()
const { languages, findLanguage } = useLanguages()

const isOpen = ref(false)
const languageValue = ref<Language>()

const languageOptions = computed(() => languages.value.map<OptionItem>(c => ({ label: c.name, value: c.code })))

watch(isOpen, () => {
  languageValue.value = { ...user.value?.language } as Language
})

const modelValue = computed({
  get: () => languageOptions.value.find((c: OptionItem<string>) => c.value === languageValue.value?.code)?.value,
  set: (code: string) => (languageValue.value = findLanguage(code)),
})

const field = ref()

const save = async () => {
  if (!isFormValid([field])) return
  if (!languageValue.value) return

  if (await updateProfile({ language: languageValue.value })) {
    applyUserLanguage()
    toast.success(t('toastDetailsSaved'))
    isOpen.value = false
  } else {
    toast.error(t('toastError'))
  }
}
</script>

<template>
  <div class="language-row">
    <dt class="term">
      {{ t('language') }}
    </dt>
    <dd class="value">
      <span class="value-text">
        {{ user?.language?.name }}
      </span>
      <span class="action">
        <BaseModal v-model:is-open="isOpen" :size="ModalSize.Small" :heading="t('language')" is-closable>
          <template #trigger>
            <button type="button" class="app-link" @click="isOpen = true">{{ t('update') }}</button>
          </template>

          <BaseSelect
            ref="field"
            v-model:value="modelValue"
            :label="t('language')"
            :options="languageOptions"
            required
          />

          <div class="buttons">
            <button type="button" class="app-btn-alt submit" @click="isOpen = false">
              {{ t('confirm.cancel') }}
            </button>
            <button type="button" class="app-btn submit" @click="save">
              {{ t('saveDetails') }}
            </button>
          </div>
        </BaseModal>
      </span>
    </dd>
  </div>
</template>

<style scoped>
.language-row {
  @apply py-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:py-5;
}

.term {
  @apply text-sm font-medium text-app-text-muted;
}

.value {
  @apply mt-1 flex text-sm text-app-text-strong sm:col-span-2 sm:mt-0;
}

.value-text {
  @apply flex-grow;
}

.action {
  @apply ml-4 flex-shrink-0;
}

.buttons {
  @apply flex gap-4;
}

.submit {
  @apply mt-8;
}
</style>
