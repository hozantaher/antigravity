<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })

const { items, total, loading, fetchPage, deleteToken, dispose } = useApiTokens()

const { page, pageSize } = useAdminPagedList({
  fetch: ({ page, pageSize }) => fetchPage({ page, pageSize }),
  dispose,
})

const createOpen = ref(false)
</script>

<template>
  <div class="app-section page">
    <div class="app-container">
      <div class="toolbar">
        <div>
          <h1 class="heading">
            API Tokens
            <span class="heading-count">({{ items === undefined ? '--' : total }})</span>
          </h1>
          <p class="subtitle">Tokens grant third-party apps full API access as you. Shown once on creation.</p>
        </div>

        <div class="toolbar-actions">
          <button
            type="button"
            class="app-btn-admin create-btn"
            data-cy="api-token-create-button"
            @click="createOpen = true"
          >
            <Icon name="heroicons-solid:plus" class="create-icon" />
            CREATE
          </button>
        </div>
      </div>

      <div class="section-wrap">
        <div class="xscroll">
          <div class="inner">
            <div class="card" :class="{ 'is-loading': loading && items }">
              <table class="datatable">
                <thead class="head">
                  <tr>
                    <th scope="col" class="th th-default">Name</th>
                    <th scope="col" class="th th-default">Token</th>
                    <th scope="col" class="th th-default">Created by</th>
                    <th scope="col" class="th th-default">Created</th>
                    <th scope="col" class="th th-default">Last used</th>
                    <th scope="col" class="th th-action" />
                  </tr>
                </thead>
                <tbody v-if="items?.length" class="body">
                  <tr v-for="token in items" :key="token.id" class="data-row">
                    <td class="td td-name">{{ token.name }}</td>
                    <td class="td td-default">
                      <code class="prefix">{{ token.tokenPrefix }}…</code>
                    </td>
                    <td class="td td-default">{{ token.createdByName ?? '—' }}</td>
                    <td class="td td-default">{{ formatDate(token.createdAt) }}</td>
                    <td class="td td-default">{{ token.lastUsedAt ? formatDate(token.lastUsedAt) : 'Never' }}</td>
                    <td class="td td-action">
                      <BaseConfirmation @on-confirm="deleteToken(token.id)">
                        <div class="app-text-btn" data-cy="api-token-delete-button" :data-cy-id="token.id">Revoke</div>
                      </BaseConfirmation>
                    </td>
                  </tr>
                </tbody>
                <TableBodySkeletor v-if="!items" :rows="5" :cols="6" />
              </table>
            </div>
          </div>
        </div>
        <div v-if="items?.length === 0" class="empty">
          No API tokens yet. Create one to grant third-party access to the API.
        </div>
        <BasePagination v-model:page="page" :total="total" :page-size="pageSize" variant="admin" />
      </div>
    </div>

    <ApiTokenCreateDialog :open="createOpen" @close="createOpen = false" />
  </div>
</template>

<style scoped>
.page {
  @apply flex-1;
}

.toolbar {
  @apply flex w-full flex-col items-start justify-between gap-8 lg:inline-flex lg:flex-row lg:items-end;
}

.heading {
  @apply text-lg font-semibold text-app-text-strong;
}

.heading-count {
  @apply text-lg text-app-text-muted;
}

.subtitle {
  @apply mt-2 text-app-text;
}

.toolbar-actions {
  @apply w-full lg:w-auto;
}

.create-btn {
  @apply flex w-auto items-center gap-2;
}

.create-icon {
  @apply h-4 w-4 text-white;
}

.section-wrap {
  @apply mt-4 flex flex-col;
}

.xscroll {
  @apply -mx-3 overflow-x-auto md:mx-0;
}

.inner {
  @apply inline-block min-w-full px-0.5 py-2 align-middle;
}

.card {
  @apply overflow-hidden border border-app-border bg-app-surface transition-opacity duration-200 md:rounded-lg;

  &.is-loading {
    @apply pointer-events-none opacity-60;
  }
}

.datatable {
  @apply min-w-full divide-y divide-app-border;
}

.head {
  @apply bg-app-surface-muted;
}

.th {
  @apply text-left text-xs font-medium tracking-wide text-app-text-muted uppercase;
}

.th-default {
  @apply px-3 py-3.5;
}

.th-action {
  @apply relative py-3.5 pr-4 pl-3 sm:pr-6;
}

.body {
  @apply divide-y divide-app-border bg-app-surface;
}

.data-row {
  &:hover {
    @apply bg-app-surface-muted;
  }
}

.td {
  @apply py-4 text-sm whitespace-nowrap;
}

.td-name {
  @apply px-3 font-medium text-app-text-strong;
}

.td-default {
  @apply px-3 text-app-text;
}

.td-action {
  @apply relative px-3 font-medium;
}

.prefix {
  @apply rounded-sm bg-app-surface-muted px-2 py-1 font-mono text-xs text-app-text;
}

.empty {
  @apply mt-8 text-center text-sm text-app-text-muted;
}
</style>
