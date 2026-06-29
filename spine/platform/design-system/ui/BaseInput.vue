<script setup lang="ts">
import type BaseValidator from '~/models/BaseValidator'

interface Props {
  type: string
  name?: string
  label?: string
  value?: any
  placeholder?: string
  required?: boolean
  validators?: BaseValidator[]
  readOnly?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  required: false,
})
const emits = defineEmits(['update:value'])

const isValid = ref(true)
const errMessage = ref('')

const { t } = useI18n()

// Native number inputs hand back strings; coerce so numeric models (bids, prices)
// actually hold numbers instead of relying on downstream `Number()` coercion.
const modelValue = computed({
  get: (): string => props.value ?? '',
  set: (val: string) => emits('update:value', props.type === 'number' ? (val === '' ? undefined : Number(val)) : val),
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
    <label v-if="label" class="field-label" :class="{ 'is-error': errMessage }">
      {{ label }}{{ required ? '*' : '' }}
    </label>

    <div class="field-box" :class="{ 'is-error': errMessage }">
      <div v-if="!!$slots.prefix" class="field-affix">
        <slot name="prefix" />
      </div>

      <input
        v-model="modelValue"
        :name="name"
        :type="type"
        :readonly="readOnly"
        class="field-input"
        :class="{ 'is-suffixed': !!$slots.suffix || errMessage, 'is-prefixed': !!$slots.prefix }"
        :placeholder="placeholder"
      />

      <div v-if="!!$slots.suffix && !errMessage" class="field-affix is-nowrap">
        <slot name="suffix" />
      </div>
      <div v-if="errMessage" class="field-affix is-nowrap">
        <Icon name="heroicons-solid:exclamation-circle" class="field-error-icon" />
      </div>
    </div>
    <p v-if="errMessage" class="field-error-text">
      {{ errMessage }}
    </p>
    <p v-if="!!$slots.hint && !errMessage" class="field-hint">
      <slot name="hint" />
    </p>
  </div>
</template>

<style scoped>
.field-label {
  @apply mb-1 block text-sm font-medium text-app-text;

  &.is-error {
    @apply text-app-red;
  }
}

.field-box {
  @apply flex h-10 items-center rounded-lg border border-app-border bg-app-surface;
  @apply focus-within:border-app-primary focus-within:ring-1 focus-within:ring-app-primary;

  &.is-error {
    @apply border-app-red text-app-red;
    @apply focus-within:!border-app-red focus-within:!ring-app-red;
  }
}

.field-affix {
  @apply px-2.5;

  &.is-nowrap {
    @apply whitespace-nowrap;
  }
}

.field-input {
  @apply w-full self-stretch rounded-lg border-app-surface px-2 focus:outline-none sm:text-sm;

  &.is-suffixed {
    @apply rounded-r-none;
  }

  &.is-prefixed {
    @apply rounded-l-none;
  }
}

.field-error-icon {
  @apply text-18 text-app-red;
}

.field-error-text {
  @apply mt-1 text-sm text-app-red;
}

.field-hint {
  @apply mt-1 text-sm text-app-text-muted;
}
</style>
