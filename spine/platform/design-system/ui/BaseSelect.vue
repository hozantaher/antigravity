<script lang="ts" setup>
import Multiselect from '@vueform/multiselect'
import type { OptionItem } from '~/models'

interface Props {
  name?: string
  label?: string
  placeholder?: string
  value?: any
  required?: boolean
  options: OptionItem[]
  multiple?: boolean
  searchable?: boolean
  closeOnSelect?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '---',
  required: false,
  multiple: false,
  searchable: true,
  closeOnSelect: true,
})

const emits = defineEmits(['update:value'])

const isValid = ref(true)
const errMessage = ref('')

const { t } = useI18n()

const modelValue = computed({
  get: () => props.value ?? (props.multiple ? [] : ''),
  set: val => emits('update:value', val),
})

const validate = () => {
  if (props.required && [undefined, null, '', ' '].includes(modelValue.value)) {
    isValid.value = false
    errMessage.value = t('requiredField')
    return
  }

  isValid.value = true
  errMessage.value = ''
}

watch(modelValue, validate)

defineExpose({ validate, isValid })
</script>

<template>
  <div>
    <label v-if="label" class="dropdown-label" :class="{ 'has-error': errMessage }">
      {{ label }}{{ required ? '*' : '' }}
    </label>

    <div class="dropdown-box">
      <!-- @vueform/multiselect renders its option list / fragments differently on
           server vs client, so SSR hydration mismatches. It needs JS to work anyway —
           render it client-only with a height-matched fallback to avoid layout shift. -->
      <ClientOnly>
        <Multiselect
          v-model="modelValue"
          :name="name"
          :placeholder="placeholder"
          :options="options"
          :mode="multiple ? 'tags' : 'single'"
          :searchable="searchable"
          :close-on-select="closeOnSelect"
        />
        <template #fallback>
          <div class="dropdown-fallback">{{ placeholder }}</div>
        </template>
      </ClientOnly>
    </div>
    <p v-if="errMessage" class="dropdown-error">
      {{ errMessage }}
    </p>
    <p v-if="!!$slots.hint && !errMessage" class="dropdown-hint">
      <slot name="hint" />
    </p>
  </div>
</template>

<style>
:root {
  --ms-max-height: 350px;

  /* Align @vueform/multiselect vendor theme to the app tokens: hairline border,
     blue (chrome) focus/active + selection, flat rounded-lg radius. */
  --ms-radius: var(--radius-lg, 0.5rem);
  --ms-dropdown-radius: var(--radius-lg, 0.5rem);
  --ms-border-color: var(--color-app-border);
  --ms-border-color-active: var(--color-app-primary);
  --ms-ring-color: color-mix(in srgb, var(--color-app-primary) 25%, transparent);
  --ms-dropdown-border-color: var(--color-app-border);
  --ms-tag-bg: var(--color-app-primary);
  --ms-option-bg-selected: var(--color-app-primary);
  --ms-option-bg-selected-pointed: var(--color-app-primary-hover);
}
</style>

<style scoped>
.dropdown-label {
  @apply mb-1 block text-sm font-medium text-app-text;

  &.has-error {
    @apply text-app-red;
  }
}

.dropdown-box {
  @apply flex min-h-9.5;
}

.dropdown-fallback {
  @apply flex w-full items-center rounded-lg border border-app-border bg-app-surface px-3 text-sm text-app-text-muted;
}

.dropdown-error {
  @apply mt-1 text-sm text-app-red;
}

.dropdown-hint {
  @apply mt-1 text-sm text-app-text-muted;
}
</style>

<!-- Multiselect theme styles its own global DOM, so this stays unscoped — but lives here
     (not in global main.css) so it ships only in BaseSelect's chunk, not on every page. -->
<style>
@import '@vueform/multiselect/themes/default.css';
</style>
