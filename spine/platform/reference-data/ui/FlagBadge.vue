<script lang="ts" setup>
const props = defineProps<{ countryCode?: string | null }>()

const { findCountryByCode2 } = useCountries()
const country = computed(() => (props.countryCode ? findCountryByCode2(props.countryCode) : undefined))
</script>

<template>
  <Icon v-if="countryCode" :name="`circle-flags:${countryCode}`" class="flag-badge" :aria-label="country?.name" />
</template>

<style scoped>
.flag-badge {
  /* 25% overhang: badge ukotven na rohu (top/left 0) a posunut o ¼ vlastní velikosti ven —
     translate v % drží offset párově s velikostí bez arbitrary px. */
  @apply absolute top-0 left-0 z-10 h-5 w-5 -translate-x-1/4 -translate-y-1/4 rounded-full shadow-md;
}
</style>
