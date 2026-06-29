<script lang="ts" setup>
const { item, clearBids } = useAdminItem()

const { user } = useUser()

const pageSize = 10
const page = ref(1)

// Admin edits bids in memory (clearBids) before saving, so paginate the local
// array rather than the server — the view must reflect unsaved changes.
const allBids = computed(() => (item.value ? [...item.value.bids].reverse() : []))
const total = computed(() => allBids.value.length)
const pageOffset = computed(() => (page.value - 1) * pageSize)
const pageBids = computed(() => allBids.value.slice(pageOffset.value, page.value * pageSize))

watch(total, () => {
  const maxPage = Math.max(1, Math.ceil(total.value / pageSize))
  if (page.value > maxPage) page.value = maxPage
})
</script>

<template>
  <div v-if="item" class="layout">
    <div class="app-panel panel">
      <div class="app-panel-heading heading">
        Bids history
        <BaseConfirmation @on-confirm="clearBids">
          <button type="button" class="app-btn wipe-btn">Clear bids & winner</button>
        </BaseConfirmation>
      </div>
      <ul v-if="pageBids.length" role="list" class="app-panel-body bids">
        <BidRow
          v-for="(bid, index) in pageBids"
          :key="pageOffset + index"
          :bid="bid"
          :index="pageOffset + index"
          :is-mine="bid.userId === user?.id"
          :name="bid.userId === user?.id ? `${user?.fullName} (you)` : parseUserIdentifier(bid.userId)"
          :to="`/admin/users/${bid.userId}`"
        />
      </ul>
      <div v-else class="app-panel-body empty">
        <Icon name="heroicons-outline:hand" class="empty-icon" />
        <h3 class="empty-title">Zero bids</h3>
        <p class="empty-text">There are no bids yet</p>
      </div>
      <BasePagination v-model:page="page" :total="total" :page-size="pageSize" variant="admin" class="bids-pager" />
    </div>
    <ItemInfo class="info" :item="item" />
  </div>
</template>

<style scoped>
.layout {
  @apply grid grid-cols-1 items-start justify-between gap-6 md:grid-cols-2;
}

.panel {
  @apply order-2 flow-root md:order-1;
}

.heading {
  @apply flex items-center justify-between;
}

.wipe-btn {
  @apply w-auto;
}

.bids {
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

.empty-text {
  @apply mt-1 text-app-text-muted;
}

.bids-pager {
  @apply pb-4;
}

.info {
  @apply order-1 md:order-2;
}
</style>
