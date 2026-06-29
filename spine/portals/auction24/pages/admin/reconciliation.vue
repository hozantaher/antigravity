<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })

const { movements, total, loading, fetchPage, dismiss, dispose } = useReconList()

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
            Reconciliation <span class="count">({{ movements === undefined ? '--' : total }})</span>
          </h1>
          <p class="subtitle">
            Incoming bank movements the Fio cron could not match to an open invoice. Resolve manually, then dismiss.
          </p>
        </div>
      </div>

      <div class="listing">
        <div class="listing-card" :class="{ 'is-loading': loading && movements }">
          <table class="data-table">
            <thead class="listing-head">
              <tr>
                <th scope="col" class="th th-first">Paid on</th>
                <th scope="col" class="th th-amount">Amount</th>
                <th scope="col" class="th">VS</th>
                <th scope="col" class="th">Counterparty</th>
                <th scope="col" class="th">Message</th>
                <th scope="col" class="th th-last" />
              </tr>
            </thead>
            <tbody v-if="movements?.length" class="listing-body">
              <tr v-for="m in movements" :key="`${m.account}:${m.fioId}`" class="data-row">
                <td class="td td-first">{{ formatDate(m.paidOn, 'DD.MM.yyyy') }}</td>
                <td class="td td-amount">{{ m.amount }} {{ m.currency }}</td>
                <td class="td">{{ m.vs || '—' }}</td>
                <td class="td">
                  <div>{{ m.counterName || '—' }}</div>
                  <div class="muted">{{ m.counterAccount }}</div>
                </td>
                <td class="td td-message">{{ m.message }}</td>
                <td class="td td-action">
                  <BaseConfirmation @on-confirm="dismiss(m)">
                    <button type="button" class="app-text-btn-admin">Dismiss</button>
                  </BaseConfirmation>
                </td>
              </tr>
            </tbody>
            <TableBodySkeletor v-if="!movements" :rows="5" :cols="6" />
          </table>
        </div>
        <NoItems v-if="movements?.length === 0" class="no-items" />
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

.th-amount {
  @apply px-3 py-3.5 text-right;
}

.th-last {
  @apply relative py-3.5 pr-4 pl-3 sm:pr-6;
}

.listing-body {
  @apply divide-y divide-app-border bg-app-surface;
}

.td {
  @apply px-3 py-4 text-sm whitespace-nowrap text-app-text;
}

.td-first {
  @apply py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-app-text-strong sm:pl-6;
}

.td-amount {
  @apply text-right tabular-nums;
}

.td-message {
  @apply max-w-xs truncate whitespace-normal text-app-text-muted;
}

.td-action {
  @apply relative px-3 py-4 text-sm font-medium whitespace-nowrap;
}

.muted {
  @apply text-xs text-app-text-muted;
}

.no-items {
  @apply mt-16;
}
</style>
