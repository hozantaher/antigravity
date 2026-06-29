<script lang="ts" setup>
import LocaleTabs from './LocaleTabs.vue'

const { item, selectedLocale } = useAdminItem()
</script>

<template>
  <div class="wrap">
    <h3 class="heading">Description</h3>
    <LocaleTabs />
    <div>
      <BaseTextarea
        v-model:value="item!.description[selectedLocale]"
        placeholder="Description"
        :rows="20"
        class="textarea-full"
      />
    </div>
  </div>
</template>

<style scoped>
.wrap {
  @apply mb-2 flex flex-col gap-4;
}

.heading {
  @apply text-lg font-medium text-app-text-strong;
}

.textarea-full {
  @apply w-full;
}
</style>
