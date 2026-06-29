<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import type { Item } from '~/models'

const props = defineProps<{ item: Item }>()

const { t } = useI18n()
const toast = useToast()
const tracking = useTracking()
const { share, isSupported: isShareSupported } = useShare()
const { copy, isSupported: isCopySupported } = useClipboard()

// VueUse isSupported is false on the server (no navigator) and true on the client, so the
// trigger renders only after hydration → gate on mounted to keep SSR/client output identical.
const mounted = useMounted()

const config = useRuntimeConfig()
const requestUrl = useRequestURL()
const localePath = useLocalePath()
const origin = (config.public.baseUrl || requestUrl.origin).replace(/\/+$/, '')

const itemLink = computed(() => `${origin}${localePath(itemPath(props.item))}`)

const shareItemLink = () => {
  share({
    title: props.item.title,
    url: itemLink.value,
  })
  tracking.share(props.item.id)
}

const copyItemLink = () => {
  copy(itemLink.value)
  toast.success(t('clipboardCopied'))
  tracking.share(props.item.id)
}
</script>

<template>
  <div>
    <div v-if="mounted && isShareSupported" class="app-icon-btn trigger" @click="shareItemLink">
      <div class="trigger-label-bold">
        {{ t('share') }}
      </div>
      <Icon name="heroicons-outline:share" class="trigger-icon" />
    </div>
    <div v-else-if="mounted && isCopySupported" class="app-icon-btn trigger" @click="copyItemLink">
      <div class="trigger-label">
        {{ t('copyLink') }}
      </div>
      <Icon name="heroicons-outline:clipboard-copy" class="trigger-icon" />
    </div>
  </div>
</template>

<style scoped>
.trigger {
  @apply flex items-center gap-1;
}

.trigger-label {
  @apply font-medium;
}

.trigger-label-bold {
  @apply font-semibold;
}

.trigger-icon {
  @apply h-6 w-6;
}
</style>
