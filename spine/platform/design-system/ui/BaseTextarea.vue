<script setup lang="ts">
import type BaseValidator from '~/models/BaseValidator'

interface Props {
  name?: string
  label?: string
  value?: string
  placeholder?: string
  required?: boolean
  validators?: BaseValidator[]
  rows?: number
}

const props = withDefaults(defineProps<Props>(), {
  required: false,
  rows: 5,
})
const emits = defineEmits(['update:value'])

const isValid = ref(true)
const errMessage = ref('')

const { t } = useI18n()

const modelValue = computed({
  get: (): string => props.value ?? '',
  set: (val: string) => emits('update:value', val),
})

const validate = () => {
  if (props.required && [undefined, null, '', ' '].includes(modelValue.value)) {
    isValid.value = false
    errMessage.value = t('requiredField')
    return
  }

  if (props.validators && modelValue.value) {
    for (const v of props.validators) {
      if (!v.validator(modelValue.value)) {
        isValid.value = false
        errMessage.value = v.message
        return
      }
    }
  }

  isValid.value = true
  errMessage.value = ''
}

watch(modelValue, validate)

defineExpose({ validate, isValid })
</script>

<template>
  <div>
    <label v-if="label" class="label">{{ label }}</label>

    <div class="field" :class="{ 'has-error': errMessage }">
      <textarea
        v-model="modelValue"
        :name="name"
        class="input"
        :rows="rows"
        :class="{ 'is-suffixed': !!$slots.suffix || errMessage, 'is-prefixed': !!$slots.prefix }"
        :placeholder="placeholder"
      />
    </div>
    <p v-if="errMessage" class="error">
      {{ errMessage }}
    </p>
    <p v-if="!!$slots.hint && !errMessage" class="hint">
      <slot name="hint" />
    </p>
  </div>
</template>

<style scoped>
.label {
  @apply block text-sm font-medium text-app-text;
}

.field {
  @apply mt-1 flex items-center rounded-lg border border-app-border bg-app-surface;
  @apply focus-within:border-app-primary focus-within:ring-1 focus-within:ring-app-primary;

  &.has-error {
    @apply border-app-red text-app-red;
    @apply focus-within:!border-app-red focus-within:!ring-app-red;
  }
}

.input {
  @apply flex-grow self-stretch rounded-lg border-app-surface p-2 focus:outline-none sm:text-sm;

  &.is-suffixed {
    @apply rounded-r-none;
  }

  &.is-prefixed {
    @apply rounded-l-none;
  }
}

.error {
  @apply mt-1 text-sm text-app-red;
}

.hint {
  @apply mt-1 text-sm text-app-text-muted;
}
</style>
