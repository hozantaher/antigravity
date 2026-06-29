<script setup lang="ts">
import { Skeletor } from 'vue-skeletor'

defineProps<{
  rows: number
  cols: number
}>()
</script>

<template>
  <tbody class="body">
    <tr v-for="row in rows" :key="row" class="body-row">
      <td v-for="col in cols" :key="col" class="cell">
        <Skeletor class="bar" />
      </td>
    </tr>
  </tbody>
</template>

<style scoped>
.body {
  @apply bg-app-surface;
}

.body-row {
  @apply bg-app-surface;
}

.cell {
  @apply border-b border-app-border px-4 py-4 text-sm whitespace-nowrap text-app-text-muted;
}

.bar {
  @apply !h-4 !w-90;
}
</style>
