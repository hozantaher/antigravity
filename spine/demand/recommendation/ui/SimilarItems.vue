<script lang="ts" setup>
import type { Item } from '~/models'

// Detail "Podobné inzeráty" rail (§7). Client-fetched (server:false, lazy) so the main content
// paints immediately — personalized by the a24_vid cookie + the user token (api.client plugin);
// re-fetches once auth resolves. Never errors → empty array → the rail simply doesn't render.
const props = defineProps<{ item: Item }>()
const { t } = useI18n()
const { user } = useUser()

const { data, refresh } = useAsyncData(
  `reco:item:${props.item.id}`,
  () => $fetch<Item[]>(`/api/recommendations/item/${props.item.id}`),
  { server: false, lazy: true, watch: [() => props.item.id], default: () => [] as Item[] },
)
// Token is client-only: once the user resolves, upgrade to user-personalized results.
if (import.meta.client) watch(user, u => u && refresh())
</script>

<template>
  <ItemsRail :items="data" :title="t('reco.similarTitle')" surface="detail" />
</template>
