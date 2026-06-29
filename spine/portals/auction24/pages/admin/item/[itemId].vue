<script lang="ts" setup>
defineProps<{ itemId: string }>()

definePageMeta({ layout: 'admin', middleware: 'admin' })
</script>

<template>
  <ItemDetail :item-id="itemId" />
</template>
