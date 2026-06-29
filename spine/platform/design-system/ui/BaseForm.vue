<script lang="ts" setup>
const emits = defineEmits(['onSubmit', 'onInvalidSubmit'])

const submit = () => {
  emits('onSubmit')
}
</script>

<template>
  <form @submit.prevent="submit">
    <slot />
    <slot name="button" />
  </form>
</template>
