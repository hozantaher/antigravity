<script lang="ts" setup>
import logoUrl from '~/assets/images/logo.png'
</script>

<template>
  <div class="loading">
    <img class="logo" :src="logoUrl" alt="Auction24.cz" />
  </div>
</template>

<style scoped>
.loading {
  @apply inset-0 flex h-screen animate-pulse items-center justify-center;
}

.logo {
  @apply max-w-1/2 md:max-w-1/4;
}
</style>
