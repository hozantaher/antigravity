<script lang="ts" setup>
import type { OptionItem } from '~/models'

defineProps<{
  name: string
  value: any
  options: OptionItem[]
  label?: string
  hint?: string
}>()

const emits = defineEmits(['update:value'])

const onSelected = (option: OptionItem) => {
  emits('update:value', option.value)
}
</script>

<template>
  <fieldset>
    <legend v-if="label" class="legend">
      {{ label }}
    </legend>
    <p v-if="hint" class="hint">
      {{ hint }}
    </p>
    <div class="options">
      <div v-for="(option, index) in options" :key="index" class="option">
        <div class="dot" :class="{ 'is-selected': value === option.value }" @click="onSelected(option)" />
        <label :for="`${name}-${index}`" class="option-label" @click="onSelected(option)">
          <slot v-if="!!$slots.option" name="option" :option="option" />
          <div v-else>
            {{ option.label }}
          </div>
        </label>
      </div>
    </div>
  </fieldset>
</template>

<style scoped>
.legend {
  @apply block text-sm font-medium text-app-text;
}

.hint {
  @apply text-xs text-app-text-muted;
}

.options {
  @apply mt-4 space-y-2.5;
}

.option {
  @apply flex items-center;
}

.dot {
  @apply h-4 w-4 shrink-0 rounded-full border border-app-border-strong;

  &.is-selected {
    @apply bg-app-primary !border-2 !border-white outline outline-app-border-strong !outline-1;
  }
}

.option-label {
  @apply ml-3 block cursor-pointer text-sm font-medium text-app-text;
}
</style>
