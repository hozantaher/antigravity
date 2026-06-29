<script setup lang="ts">
const props = defineProps<{
  labels: string[]
  step: number
}>()

const isDone = (index: number): boolean => index < props.step
const isActive = (index: number): boolean => index === props.step
</script>

<template>
  <div class="stepper">
    <div v-for="(label, i) in labels" :key="label" class="segment" :class="{ 'is-last': i === labels.length - 1 }">
      <div class="node">
        <div class="dot" :class="{ 'is-done': isDone(i), 'is-active': isActive(i) }">
          <Icon v-if="isDone(i)" name="heroicons-solid:check" class="dot-check" aria-hidden="true" />
          <span v-else>{{ i + 1 }}</span>
        </div>
        <div class="node-label" :class="{ 'is-done': isDone(i), 'is-active': isActive(i) }">
          {{ label }}
        </div>
      </div>
      <div v-if="i !== labels.length - 1" class="connector" :class="{ 'is-done': isDone(i) }" />
    </div>
  </div>
</template>

<style scoped>
.stepper {
  @apply mt-4 flex items-start;
}

.segment {
  @apply flex flex-1 items-start;

  &.is-last {
    @apply flex-none;
  }
}

.node {
  @apply flex flex-col items-center gap-1;
}

.dot {
  @apply flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-app-border text-xs font-bold text-app-text-muted transition-all duration-200;

  &.is-done {
    @apply bg-app-green text-white;
  }

  &.is-active {
    @apply bg-app-primary text-white ring-4 ring-app-primary/15;
  }
}

.dot-check {
  @apply h-4 w-4;
}

.node-label {
  @apply text-xs whitespace-nowrap text-app-text-muted;

  &.is-done {
    @apply text-app-green;
  }

  &.is-active {
    @apply font-bold text-app-primary;
  }
}

.connector {
  @apply mx-2 mt-3 h-0.5 flex-1 rounded-full bg-app-border transition-colors duration-300;

  &.is-done {
    @apply bg-app-green;
  }
}
</style>
