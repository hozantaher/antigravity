<script lang="ts" setup>
import { ItemType } from '~/models'

const { item } = useItemDetail()

const { user } = useUser()

const { t } = useI18n()

const { bids, total, page, pageSize, refresh } = useItemBids(() => item.value?.id)
const pageOffset = computed(() => (page.value - 1) * pageSize)

// A new bid (own, or another viewer's via the live overlay) bumps bidCount. Jump to page 1 so it
// shows; if already there, re-fetch since the first page changed. Skip the initial undefined→count
// transition — the lazy mount fetch already covers first load.
watch(
  () => item.value?.bidCount,
  (count, prev) => {
    if (prev === undefined) return
    if (page.value === 1) refresh()
    else page.value = 1
  },
)
</script>

<template>
  <div v-if="item && item.type === ItemType.auction" class="app-panel panel">
    <div class="app-panel-heading heading">
      {{ t('bidsHistory') }}
    </div>
    <ul v-if="bids?.length" role="list" class="app-panel-body bid-list">
      <BidRow
        v-for="(bid, index) in bids"
        :key="pageOffset + index"
        :bid="bid"
        :index="pageOffset + index"
        :is-mine="bid.userId === user?.id"
        :name="bid.userId === user?.id ? `${user?.fullName} (${t('you')})` : parseUserIdentifier(bid.userId)"
      />
    </ul>
    <div v-else-if="bids" class="app-panel-body empty">
      <Icon name="heroicons-outline:hand" class="empty-icon" />
      <h3 class="empty-title">
        {{ t('noBidsYet') }}
      </h3>
      <p class="empty-desc">
        {{ t('noBidsYetDesc') }}
      </p>
    </div>
    <BasePagination v-model:page="page" :total="total" :page-size="pageSize" class="bid-pager" />
  </div>
</template>

<style scoped>
.panel {
  @apply mt-8 flow-root;
}

.heading {
  @apply flex items-center justify-between;
}

.bid-list {
  @apply divide-y divide-app-border;
}

.empty {
  @apply text-center;
}

.empty-icon {
  @apply mx-auto h-12 w-12 text-app-text-muted;
}

.empty-title {
  @apply mt-2 font-medium text-app-text-strong;
}

.empty-desc {
  @apply mt-1 text-app-text-muted;
}

.bid-pager {
  @apply pb-4;
}
</style>
