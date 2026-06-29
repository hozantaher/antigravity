<script lang="ts" setup>
import type { Item } from '~/models'

// Homepage "Vybráno pro vás" rail (§2 third surface). Anchor-less: personalized by vid/userId,
// otherwise the segment popularity average. Client-fetched (server:false, lazy) so it never blocks
// the homepage; re-fetches once auth resolves. Never errors → empty array → renders nothing.
const { t } = useI18n()
const { user } = useUser()

const { data, refresh } = useAsyncData('reco:home', () => $fetch<Item[]>('/api/recommendations/home'), {
  server: false,
  lazy: true,
  default: () => [] as Item[],
})
if (import.meta.client) watch(user, u => u && refresh())
</script>

<template>
  <ItemsRail :items="data" :title="t('reco.forYouTitle')" surface="home" />
</template>
