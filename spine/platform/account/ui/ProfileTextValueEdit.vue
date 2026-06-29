<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import type BaseValidator from '~/models/BaseValidator'
import type { User } from '~/models'
import { ModalSize } from '~/models'

const props = defineProps<{
  name: string
  title: string
  validators?: BaseValidator[]
  required?: boolean
}>()

const { t } = useI18n()

const { user, updateProfile } = useUser()
const toast = useToast()

const isOpen = ref(false)
const modelValue = ref()
const value = computed(() => (user.value ? (user.value as any)[props.name] : ''))

watch(isOpen, () => {
  modelValue.value = value.value
})

const field = ref()

const save = async () => {
  if (!isFormValid([field])) return

  if (await updateProfile({ [props.name]: modelValue.value } as Partial<User>)) {
    toast.success(t('toastDetailsSaved'))
    isOpen.value = false
  } else {
    toast.error(t('toastError'))
  }
}
</script>

<template>
  <div class="field-row">
    <dt class="label" :class="{ 'is-required': required && !value }">
      {{ title }}
    </dt>
    <dd class="value">
      <span class="value-text">
        {{ value }}
      </span>
      <span class="value-action">
        <BaseModal v-model:is-open="isOpen" :size="ModalSize.Small" :heading="title" is-closable>
          <template #trigger>
            <button type="button" class="app-link" @click="isOpen = true">{{ t('update') }}</button>
          </template>

          <BaseInput
            ref="field"
            v-model:value="modelValue"
            :label="title"
            type="text"
            :validators="validators"
            :required="required"
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
  @apply ml-4 flex-shrink-0;
}

.actions {
  @apply flex gap-4;
}

.action-btn {
  @apply mt-8;
}
</style>
