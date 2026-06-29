<script setup lang="ts">
// <img> with a one-shot fallback: if `src` fails to load — e.g. a static derivative that hasn't been
// backfilled yet — swap to `fallback` (the /img proxy URL) and drop the srcset, so the visitor never
// sees a broken image. Every other <img> attribute (alt, class, width, height, loading,
// fetchpriority, decoding, sizes) falls through via attribute inheritance.
const props = defineProps<{
  src: string
  fallback?: string
  srcset?: string
}>()

const failed = ref(false)
const el = ref<HTMLImageElement | null>(null)
// A reused <img> (e.g. gallery navigation) gets a new src — re-arm the fallback.
watch(
  () => props.src,
  () => (failed.value = false),
)

const fail = (): void => {
  if (props.fallback && !failed.value) failed.value = true
}

// An eager / fetchpriority=high image can finish loading (and error) BEFORE hydration attaches the
// @error listener, so that event is missed and the broken image sticks. On mount, if the current
// src already failed to decode (complete but zero natural size), fall back now.
onMounted(() => {
  if (el.value?.complete && el.value.naturalWidth === 0) fail()
})
</script>

<template>
  <img ref="el" :src="failed && fallback ? fallback : src" :srcset="failed ? undefined : srcset" @error="fail" />
</template>
