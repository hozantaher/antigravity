<script setup lang="ts">
const props = defineProps<{
  value: boolean
  label?: string
}>()

const emits = defineEmits(['update:value'])
</script>

<template>
  <div class="root" @click="emits('update:value', !props.value)">
    <div class="checkbox-box" :class="{ 'is-checked': props.value }" />
    <p v-if="label" class="label">
      {{ label }}
    </p>
    <slot />
  </div>
</template>

<style scoped>
.root {
  @apply flex cursor-pointer items-center gap-1.5;
}

.checkbox-box {
  @apply h-4 w-4 flex-shrink-0 rounded-sm border border-app-border-strong;

  &.is-checked {
    @apply bg-app-primary !border-2 !border-white outline outline-app-border-strong !outline-1;
  }
}

.label {
  @apply text-sm font-medium text-app-text;
}
</style>
