<script setup lang="ts">
import type { Invoice } from '~/models'

defineProps<{
  invoices?: Invoice[]
  dark?: boolean
  total?: number
  pageSize?: number
}>()

const page = defineModel<number>('page', { default: 1 })

const { t, te } = useI18n()

// Localize the known invoice statuses; legacy/unknown values (e.g. 'new') fall back
// to the raw string so historical rows still render something.
const statusLabel = (status: string): string => {
  const key = `invoiceStatus${status.charAt(0).toUpperCase()}${status.slice(1)}`
  return te(key) ? t(key) : status
}

// Unpaid-ish statuses other than the new flow's 'unpaid' exist (legacy import wrote
// 'new') — gate the links on NOT-canceled instead of one literal so those rows keep
// their payment/PDF access.
const canPay = (invoice: Invoice): boolean =>
  !!invoice.url && !invoice.paidAt && invoice.status !== INVOICE_STATUS.canceled
const showDocLink = (invoice: Invoice): boolean =>
  !!invoice.url && (!!invoice.paidAt || invoice.status !== INVOICE_STATUS.canceled)

const statusClass = (invoice: Invoice): string => {
  if (invoice.paidAt || invoice.status === INVOICE_STATUS.paid) return 'is-paid'
  if (invoice.status === INVOICE_STATUS.canceled) return 'is-canceled'
  return 'is-pending'
}
</script>

<template>
  <div>
    <div class="header">
      <div class="header-main">
        <h1 class="title">
          {{ t('invoicesTitle') }}
        </h1>
        <p class="desc">
          {{ t('invoicesDesc') }}
        </p>
      </div>
      <div class="header-action">
        <slot name="action" />
      </div>
    </div>
    <div class="data-wrap">
      <div class="data-scroll">
        <div class="data-inner">
          <div class="data-card">
            <table class="data-table">
              <thead class="thead">
                <tr>
                  <th scope="col" class="th th-first">
                    {{ t('invoiceReqDate') }}
                  </th>
                  <th scope="col" class="th th-amount">
                    {{ t('invoiceAmount') }}
                  </th>
                  <th scope="col" class="th">
                    {{ t('invoiceStatus') }}
                  </th>
                  <th scope="col" class="th">
                    {{ t('invoiceCreatedDate') }}
                  </th>
                  <th scope="col" class="th">
                    {{ t('invoiceDueDate') }}
                  </th>
                  <th scope="col" class="th">
                    {{ t('invoice') }}
                  </th>
                </tr>
              </thead>
              <tbody v-if="invoices" class="tbody">
                <tr v-for="invoice in invoices" :key="invoice.id" class="data-row">
                  <td class="td td-first">{{ formatDate(invoice.createdDate!) }} ({{ invoice.id.slice(-3) }})</td>
                  <td class="td td-amount">
                    {{ formatPrice(invoice.price) }}
                  </td>
                  <td class="td">
                    <span class="status-badge" :class="statusClass(invoice)">{{ statusLabel(invoice.status) }}</span>
                    <template v-if="invoice.paidAt"> ({{ formatDate(invoice.paidAt) }}) </template>
                    <a v-if="canPay(invoice)" target="_blank" :href="invoice.url" class="app-link pay-link">
                      {{ t('proceedPayment') }}
                    </a>
                  </td>
                  <td class="td">
                    <template v-if="invoice.invoiceCreatedDate">{{ formatDate(invoice.invoiceCreatedDate) }}</template>
                    <i v-else>{{ t('invoiceCreating') }}</i>
                  </td>
                  <td class="td">
                    {{ invoice.invoiceDueDate ? formatDate(invoice.invoiceDueDate) : '' }}
                  </td>
                  <td class="td">
                    <a v-if="showDocLink(invoice)" target="_blank" :href="invoice.url" class="app-link">
                      {{ t(invoice.paidAt ? 'showPDF' : 'proceedPayment') }}
                    </a>
                  </td>
                </tr>
              </tbody>
              <TableBodySkeletor v-else :cols="6" :rows="3" />
            </table>
          </div>
        </div>
      </div>
      <BasePagination
        v-if="total !== undefined && pageSize"
        v-model:page="page"
        :total="total"
        :page-size="pageSize"
        :variant="dark ? 'admin' : 'default'"
      />
    </div>
  </div>
</template>

<style scoped>
.header {
  @apply sm:flex sm:items-center;
}

.header-main {
  @apply sm:flex-auto;
}

.title {
  @apply text-lg font-semibold text-app-text-strong;
}

.desc {
  @apply mt-2 text-sm text-app-text-muted;
}

.header-action {
  @apply mt-4 sm:mt-0 sm:ml-16 sm:flex-none;
}

.data-wrap {
  @apply mt-8 flex flex-col;
}

.data-scroll {
  @apply -my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8;
}

.data-inner {
  @apply inline-block min-w-full py-2 align-middle md:px-6 lg:px-8;
}

.data-card {
  @apply overflow-hidden rounded-lg border border-app-border;
}

.data-table {
  @apply min-w-full divide-y divide-app-border;
}

.thead {
  @apply bg-app-surface-muted;
}

.th {
  @apply px-3 py-3 text-left text-xs font-semibold tracking-wide text-app-text-muted uppercase;
}

.th-first {
  @apply py-3 pl-4 pr-3 sm:pl-6;
}

.th-amount {
  @apply text-right;
}

.tbody {
  @apply divide-y divide-app-border bg-app-surface;
}

.data-row {
  @apply hover:bg-app-surface-muted;
}

.td {
  @apply whitespace-nowrap px-3 py-4 text-sm text-app-text;
}

.td-first {
  @apply py-4 pl-4 pr-3 text-sm font-medium text-app-text-strong sm:pl-6;
}

.td-amount {
  @apply text-right font-medium text-app-text-strong tabular-nums;
}

.status-badge {
  @apply inline-flex items-center rounded-full bg-app-surface-muted px-2 py-0.5 text-xs font-medium text-app-text-muted capitalize;

  &.is-paid {
    @apply bg-app-green/10 text-app-green;
  }

  &.is-pending {
    @apply bg-app-amber/10 text-app-amber;
  }

  &.is-canceled {
    @apply bg-app-surface-muted text-app-text-muted;
  }
}

.pay-link {
  @apply block lg:hidden;
}
</style>
