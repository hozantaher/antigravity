<script lang="ts" setup>
const props = defineProps<{
  id?: number
  title: string
  value: string
  locale: string
}>()

const emits = defineEmits(['update:value', 'update:title', 'remove'])

const modelTitle = computed({
  get: (): string => props.title,
  set: (val: string) => emits('update:title', val),
})
const modelValue = computed({
  get: (): string => props.value,
  set: (val: string) => emits('update:value', val),
})
</script>

<template>
  <div class="highlight-row">
    <Icon name="heroicons-solid:menu" class="handle drag-handle" />
    <div class="fields">
      <BaseInput v-if="!!id" :value="modelTitle" type="text" class="title-field" read-only />
      <BaseInput v-else v-model:value="modelTitle" type="text" class="title-field" />
      <div class="value-cell">
        <BaseInput v-model:value="modelValue" class="value-field" type="text" />
        <Icon name="heroicons-solid:trash" class="remove-icon" @click="emits('remove')" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.highlight-row {
  @apply flex items-center;
}

.drag-handle {
  @apply mr-2 h-5 w-5 cursor-pointer;
}

.fields {
  @apply grid w-full grid-cols-2 gap-4;
}

.title-field {
  @apply col-span-1;
}

.value-cell {
  @apply col-span-1 flex items-center gap-3;
}

.value-field {
  @apply w-full;
}

.remove-icon {
  @apply h-6 w-6 cursor-pointer text-app-red;
}
</style>
