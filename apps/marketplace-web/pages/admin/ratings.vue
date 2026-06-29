<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })

const { ratings, total, loading, fetchPage, setStatus, dispose } = useRatingList()

const { page, pageSize } = useAdminPagedList({
  fetch: ({ page, pageSize, q }) => fetchPage({ page, pageSize, q }),
  dispose,
})
</script>

<template>
  <div class="app-section page">
    <div class="app-container">
      <div class="header">
        <div class="header-main">
          <h1 class="title">
            Ratings <span class="count">({{ ratings === undefined ? '--' : total }})</span>
          </h1>
          <p class="subtitle">Buyer ratings of sellers. Hide a fraudulent rating to drop it from reputation.</p>
        </div>
      </div>

      <div class="listing">
        <div class="listing-card" :class="{ 'is-loading': loading && ratings }">
          <table class="data-table">
            <thead class="listing-head">
              <tr>
                <th scope="col" class="th th-first">Item</th>
                <th scope="col" class="th">Seller</th>
                <th scope="col" class="th">Rater</th>
                <th scope="col" class="th">Score</th>
                <th scope="col" class="th">Comment</th>
                <th scope="col" class="th">Status</th>
                <th scope="col" class="th th-last" />
              </tr>
            </thead>
            <tbody v-if="ratings?.length" class="listing-body">
              <tr v-for="r in ratings" :key="r.id" class="data-row" :class="{ 'is-hidden': r.status === 'hidden' }">
                <td class="td td-first">
                  <NuxtLink :to="`/admin/item/${r.itemId}`" target="_blank" class="link">{{ r.itemId }}</NuxtLink>
                </td>
                <td class="td">
                  <NuxtLink :to="`/admin/users/${r.sellerId}`" target="_blank" class="link">{{
                    parseUserIdentifier(r.sellerId)
                  }}</NuxtLink>
                </td>
                <td class="td">{{ parseUserIdentifier(r.raterId) }}</td>
                <td class="td score">★ {{ r.score }}</td>
                <td class="td td-comment">{{ r.comment }}</td>
                <td class="td">
                  <span class="status" :class="`is-${r.status}`">{{ r.status }}</span>
                </td>
                <td class="td td-action">
                  <BaseConfirmation v-if="r.status === 'visible'" @on-confirm="setStatus(r, 'hidden')">
                    <button type="button" class="app-text-btn-admin">Hide</button>
                  </BaseConfirmation>
                  <button v-else type="button" class="app-text-btn-admin" @click="setStatus(r, 'visible')">
                    Restore
                  </button>
                </td>
              </tr>
            </tbody>
            <TableBodySkeletor v-if="!ratings" :rows="5" :cols="7" />
          </table>
        </div>
        <NoItems v-if="ratings?.length === 0" class="no-items" />
        <BasePagination v-model:page="page" :total="total" :page-size="pageSize" variant="admin" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  @apply flex-1;
}

.header {
  @apply sm:flex sm:items-center;
}

.header-main {
  @apply sm:flex-auto;
}

.title {
  @apply text-lg font-semibold text-app-text-strong;
}

.count {
  @apply text-lg text-app-text-muted;
}

.subtitle {
  @apply mt-2 hidden text-app-text md:block;
}

.listing {
  @apply mt-8 flex flex-col;
}

.listing-card {
  @apply overflow-hidden border border-app-border bg-app-surface transition-opacity duration-200 rounded-lg;

  &.is-loading {
    @apply pointer-events-none opacity-60;
  }
}

.data-table {
  @apply min-w-full divide-y divide-app-border;
}

.listing-head {
  @apply bg-app-surface-muted;
}

.th {
  @apply px-3 py-3.5 text-left text-xs font-medium tracking-wide text-app-text-muted uppercase;
}

.th-first {
  @apply py-3.5 pr-3 pl-4 text-left text-xs font-medium tracking-wide text-app-text-muted uppercase sm:pl-6;
}

.th-last {
  @apply relative py-3.5 pr-4 pl-3 sm:pr-6;
}

.listing-body {
  @apply divide-y divide-app-border bg-app-surface;
}

.data-row {
  &.is-hidden {
    @apply opacity-50;
  }
}

.td {
  @apply px-3 py-4 text-sm whitespace-nowrap text-app-text;
}

.td-first {
  @apply py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-app-text-strong sm:pl-6;
}

.td-comment {
  @apply max-w-xs truncate whitespace-normal text-app-text-muted;
}

.td-action {
  @apply relative px-3 py-4 text-sm font-medium whitespace-nowrap;
}

.link {
  @apply text-app-primary;

  &:hover {
    @apply underline;
  }
}

.score {
  @apply font-medium text-app-amber tabular-nums;
}

.status {
  @apply inline-flex items-center rounded-full bg-app-green/10 px-2 py-0.5 text-xs font-medium text-app-green;

  &.is-hidden {
    @apply bg-app-primary/10 text-app-primary;
  }
}

.no-items {
  @apply mt-16;
}
</style>
