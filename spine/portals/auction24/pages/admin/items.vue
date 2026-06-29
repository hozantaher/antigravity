<script setup lang="ts">
import { ItemType } from '~/models'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { items, total, loading, fetchPage, deleteItem, updateVisibility, dispose } = useItemList()

const visibility = ref<'visible' | 'hidden' | 'all'>('visible')

const { page, pageSize } = useAdminPagedList({
  fetch: ({ page, pageSize, q }) => fetchPage({ page, pageSize, q, visibility: visibility.value }),
  filters: [visibility],
  dispose,
})
</script>

<template>
  <div class="app-section page">
    <div class="app-container">
      <div class="toolbar">
        <div>
          <h1 class="heading">
            Items
            <span class="heading-count">({{ items === undefined ? '--' : total }})</span>
          </h1>
          <p class="subtitle">A list of all the items in system.</p>
        </div>

        <div class="create-mobile">
          <button type="button" class="app-btn-admin create-btn" @click="$router.push('/admin/item')">
            <Icon name="heroicons-solid:plus" class="create-icon" />
            CREATE
          </button>
        </div>

        <div class="filters">
          <button
            :class="{ 'is-active': visibility === 'visible' }"
            type="button"
            class="filter-btn"
            @click="visibility = 'visible'"
          >
            Visible
          </button>
          <button
            :class="{ 'is-active': visibility === 'hidden' }"
            type="button"
            class="filter-btn"
            @click="visibility = 'hidden'"
          >
            Hidden
          </button>
          <button
            :class="{ 'is-active': visibility === 'all' }"
            type="button"
            class="filter-btn"
            @click="visibility = 'all'"
          >
            All
          </button>
        </div>

        <div class="create-desktop">
          <button type="button" class="app-btn-admin create-btn" @click="$router.push('/admin/item')">
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
                    <th scope="col" class="th th-id">ID</th>
                    <th scope="col" class="th th-created">Created</th>
                    <th scope="col" class="th th-default">Title</th>
                    <th scope="col" class="th th-default">Type</th>
                    <th scope="col" class="th th-default">Visible</th>
                    <th scope="col" class="th th-price th-nowrap">Initial price</th>
                    <th scope="col" class="th th-price th-nowrap">Minimal price</th>
                    <th scope="col" class="th th-default">Location</th>
                    <th scope="col" class="th th-action" />
                    <th scope="col" class="th th-action" />
                  </tr>
                </thead>
                <tbody v-if="items?.length" class="body">
                  <NuxtLink
                    v-for="item in items"
                    :key="item.id"
                    v-slot="{ isActive, href, navigate }"
                    :to="`/admin/item/${item.id}`"
                    custom
                  >
                    <tr class="data-row" :class="{ 'is-active': isActive, 'is-sold': item.sold }" @click="navigate">
                      <td class="td td-id">
                        {{ item.internalId }}
                      </td>
                      <td class="td td-created">
                        <template v-if="item.created">
                          {{ formatDate(item.created!) }}
                        </template>
                      </td>
                      <td class="td td-title">
                        {{ item.title }}
                      </td>
                      <td class="td td-default">
                        <span :class="item.type === ItemType.auction ? 'is-auction' : 'is-other'" class="tag">{{
                          item.type.toString().toUpperCase()
                        }}</span>
                      </td>
                      <td class="td td-default">
                        <BaseConfirmation @on-confirm="updateVisibility(item)">
                          <span :class="item.hidden ? 'is-hidden' : 'is-visible'" class="tag">{{
                            item.hidden ? 'Hidden' : 'Visible'
                          }}</span>
                        </BaseConfirmation>
                      </td>
                      <td class="td td-price">
                        {{ formatPrice(item.priceFrom) }}
                      </td>
                      <td class="td td-price">
                        {{ formatPrice(item.minimalPrice) }}
                      </td>
                      <td class="td td-default">
                        <Icon v-if="item.countryCode" :name="`flag:${item.countryCode}-4x3`" class="flag-icon" />
                        {{ item.location }}
                      </td>
                      <td class="td td-action">
                        <BaseConfirmation @on-confirm="deleteItem(item)">
                          <div class="app-text-btn">Delete</div>
                        </BaseConfirmation>
                      </td>
                      <td class="td td-action">
                        <a :href="href ?? undefined" class="app-text-btn-admin" @click="navigate"> View </a>
                      </td>
                    </tr>
                  </NuxtLink>
                </tbody>
                <TableBodySkeletor v-if="!items" :rows="5" :cols="10" />
              </table>
            </div>
          </div>
        </div>
        <NoItems v-if="items?.length === 0" class="no-items" />
        <BasePagination v-model:page="page" :total="total" :page-size="pageSize" variant="admin" />
      </div>
    </div>
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
  @apply mt-2 hidden text-app-text lg:block;
}

.create-mobile {
  @apply lg:hidden;
}

.create-desktop {
  @apply hidden lg:block;
}

.create-btn {
  @apply flex w-auto items-center gap-2;
}

.create-icon {
  @apply h-4 w-4 text-white;
}

.filters {
  @apply flex gap-1 border-b border-app-border lg:justify-end;
}

.filter-btn {
  @apply -mb-px cursor-pointer border-b-2 border-transparent px-4 py-2 text-sm font-medium text-app-text-muted;

  &:hover {
    @apply text-app-text;
  }

  &:focus-visible {
    @apply rounded-sm outline-none ring-2 ring-app-primary/40;
  }

  &.is-active {
    @apply border-app-primary text-app-text-strong;
  }
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

.th-id {
  @apply py-3.5 pr-3 pl-2 sm:pl-6;
}

.th-created {
  @apply py-3.5 pr-3;
}

.th-default {
  @apply px-3 py-3.5;
}

.th-price {
  @apply px-3 py-3.5 text-right;
}

.th-nowrap {
  @apply whitespace-nowrap;
}

.th-action {
  @apply relative py-3.5 pr-4 pl-3 sm:pr-6;
}

.body {
  @apply divide-y divide-app-border bg-app-surface;
}

.data-row {
  @apply cursor-pointer;

  &:hover {
    @apply bg-app-surface-muted;
  }

  &.is-active {
    @apply bg-app-surface-muted;
  }

  &.is-sold {
    @apply bg-app-surface-muted;
  }
}

.td {
  @apply py-4 text-sm whitespace-nowrap;
}

.td-id {
  @apply pr-3 pl-2 font-medium text-app-text-strong sm:pl-6;
}

.td-created {
  @apply pr-3 font-medium text-app-text-strong;
}

.td-default {
  @apply px-3 text-app-text;
}

.td-title {
  @apply px-3 font-medium text-app-primary;

  &:hover {
    @apply underline;
  }
}

.td-price {
  @apply px-3 text-right text-app-text tabular-nums;
}

.td-action {
  @apply relative px-3 font-medium;
}

.tag {
  @apply mr-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium;

  &.is-auction {
    @apply bg-app-primary/10 text-app-primary;
  }

  &.is-other {
    @apply bg-app-green/10 text-app-green;
  }

  &.is-hidden {
    @apply bg-app-surface-muted text-app-text-muted;
  }

  &.is-visible {
    @apply bg-app-green/10 text-app-green;
  }
}

.flag-icon {
  @apply mr-1 inline-block align-middle text-18;
}

.no-items {
  @apply mt-16;
}
</style>
