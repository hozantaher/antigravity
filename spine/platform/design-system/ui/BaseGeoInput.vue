<script lang="ts" setup>
import type { Gps } from '~/models'

// Mock backend: Google Places autocomplete is replaced by a plain address
// field that emits a Gps with placeholder coordinates. Swap for the real
// geocoder when the backend is wired up.
const props = defineProps<{ value?: Gps }>()
const emits = defineEmits(['update:value'])

const { t } = useI18n()

const address = ref(props.value?.address ?? '')

watch(address, val => {
  emits('update:value', val ? ({ address: val, lat: 50.0755, lng: 14.4378 } as Gps) : undefined)
})
</script>

<template>
  <div>
    <div class="field">
      <input v-model="address" :placeholder="t('searchPlace')" class="input" />
      <div class="chevron-box">
        <Icon name="heroicons-solid:chevron-up" class="chevron-icon" aria-hidden="true" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.field {
  @apply relative mt-1;
}

.input {
  @apply h-10 w-full rounded-lg border border-app-border bg-app-surface py-2 pr-10 pl-3 text-sm font-medium text-app-text focus:border-app-primary focus:ring-1 focus:ring-app-primary focus:outline-none sm:text-sm;
}

.chevron-box {
  @apply absolute inset-y-0 right-0 flex items-center rounded-r-lg px-2;
}

.chevron-icon {
  @apply h-5 w-5 text-app-text-muted;
}
</style>
