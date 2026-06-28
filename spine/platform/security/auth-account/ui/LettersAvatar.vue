<script lang="ts" setup>
const props = defineProps<{
  name: string
}>()

const text = computed(() => {
  const words = props.name.split(' ')
  if (words.length === 1) return words[0]!.substring(0, 1)
  return `${words[0]!.substring(0, 1)}${words[words.length - 1]!.substring(0, 1)}`
})
</script>

<template>
  <span class="avatar">
    <span class="initials">{{ text.toUpperCase() }}</span>
  </span>
</template>

<style scoped>
.avatar {
  @apply inline-flex h-8 w-8 items-center justify-center rounded-full bg-gray-500;
}

.initials {
  @apply leading-none font-medium text-white;
}
</style>
