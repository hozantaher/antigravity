<script lang="ts" setup>
import { useToast } from 'vue-toastification'

const { t } = useI18n()
const localePath = useLocalePath()

useSeo({ noindex: true })

onMounted(async () => {
  useToast().success(t('formSentSuccessMsg'))
  await navigateTo(localePath('/'))
})
</script>

<template>
  <div />
</template>
