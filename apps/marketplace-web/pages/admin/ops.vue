<script setup lang="ts">
import { ref, onMounted } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface JobRun {
  id: string
  job: string
  startedAt: number
  finishedAt: number | null
  ok: boolean | null
  counts: Record<string, unknown> | null
  error: string | null
}
interface JobHealth extends JobRun {
  stale: boolean
  healthy: boolean
}
interface OpsResponse {
  health: JobHealth[]
  recent: JobRun[]
}

const data = ref<OpsResponse>()
const loading = ref(true)

const load = async () => {
  loading.value = true
  try {
    data.value = await $fetch<OpsResponse>('/api/admin/ops')
  } finally {
    loading.value = false
  }
}
onMounted(load)

const ago = (ms: number | null): string => {
  if (!ms) return '—'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
}

const statusOf = (h: JobHealth): 'ok' | 'warn' | 'fail' => {
  if (h.ok === false) return 'fail'
  if (h.stale) return 'warn'
  return 'ok'
}

const summary = (counts: Record<string, unknown> | null): string =>
  counts
    ? Object.entries(counts)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join('  ·  ')
    : '—'
</script>

<template>
  <div class="app-section page">
    <div class="app-container">
      <div class="header">
        <div class="header-main">
          <h1 class="title">Operations</h1>
          <p class="subtitle">Scheduled job health — last run, outcome and result counts per cron.</p>
        </div>
        <button type="button" class="app-btn-alt refresh" :disabled="loading" @click="load">Refresh</button>
      </div>

      <div v-if="data" class="health-grid">
        <div v-for="h in data.health" :key="h.job" class="health-card" :class="`is-${statusOf(h)}`">
          <div class="health-top">
            <span class="dot" />
            <span class="job-name">{{ h.job }}</span>
            <span class="run-age">{{ ago(h.finishedAt ?? h.startedAt) }}</span>
          </div>
          <div class="health-counts">{{ summary(h.counts) }}</div>
          <div v-if="h.error" class="health-error">{{ h.error }}</div>
        </div>
        <p v-if="data.health.length === 0" class="empty">No job runs recorded yet.</p>
      </div>

      <div v-if="data?.recent.length" class="listing">
        <h2 class="section-title">Recent runs</h2>
        <div class="listing-card">
          <table class="data-table">
            <thead class="listing-head">
              <tr>
                <th scope="col" class="th th-first">Job</th>
                <th scope="col" class="th">Started</th>
                <th scope="col" class="th">Status</th>
                <th scope="col" class="th">Counts</th>
                <th scope="col" class="th">Error</th>
              </tr>
            </thead>
            <tbody class="listing-body">
              <tr v-for="r in data.recent" :key="r.id" class="data-row">
                <td class="td td-first">{{ r.job }}</td>
                <td class="td">{{ ago(r.startedAt) }}</td>
                <td class="td">
                  <span class="badge" :class="r.ok === false ? 'is-fail' : r.ok ? 'is-ok' : 'is-pending'">
                    {{ r.ok === false ? 'FAILED' : r.ok ? 'OK' : 'RUNNING' }}
                  </span>
                </td>
                <td class="td td-counts">{{ summary(r.counts) }}</td>
                <td class="td td-error">{{ r.error ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  @apply flex-1;
}

.header {
  @apply flex items-start justify-between gap-4;
}

.header-main {
  @apply flex-auto;
}

.title {
  @apply text-lg font-semibold text-app-text-strong;
}

.subtitle {
  @apply mt-2 hidden text-app-text md:block;
}

.refresh {
  @apply shrink-0;
}

.health-grid {
  @apply mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3;
}

.health-card {
  @apply border border-app-border bg-app-surface p-4 rounded-lg;

  &.is-warn {
    @apply border-app-amber;
  }

  &.is-fail {
    @apply border-app-primary;
  }
}

.health-top {
  @apply flex items-center gap-2;
}

.dot {
  @apply inline-block size-2 rounded-full bg-app-green;

  .is-warn & {
    @apply bg-app-amber;
  }

  .is-fail & {
    @apply bg-app-primary;
  }
}

.job-name {
  @apply text-sm font-semibold text-app-text-strong;
}

.run-age {
  @apply ml-auto text-xs text-app-text-muted tabular-nums;
}

.health-counts {
  @apply mt-2 text-xs text-app-text-muted;
}

.health-error {
  @apply mt-2 text-xs text-app-primary;
}

.empty {
  @apply text-app-text-muted;
}

.listing {
  @apply mt-10;
}

.section-title {
  @apply mb-3 text-sm font-semibold tracking-wide text-app-text-muted uppercase;
}

.listing-card {
  @apply overflow-hidden border border-app-border bg-app-surface rounded-lg;
}

.data-table {
  @apply min-w-full divide-y divide-app-border;
}

.listing-head {
  @apply bg-app-surface-muted;
}

.th {
  @apply px-3 py-3 text-left text-xs font-medium tracking-wide text-app-text-muted uppercase;
}

.th-first {
  @apply py-3 pr-3 pl-4 text-left text-xs font-medium tracking-wide text-app-text-muted uppercase sm:pl-6;
}

.listing-body {
  @apply divide-y divide-app-border bg-app-surface;
}

.td {
  @apply px-3 py-3 text-sm whitespace-nowrap text-app-text;
}

.td-first {
  @apply py-3 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-app-text-strong sm:pl-6;
}

.td-counts {
  @apply text-xs whitespace-normal text-app-text-muted;
}

.td-error {
  @apply text-xs whitespace-normal text-app-primary;
}

.badge {
  @apply inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium;

  &.is-ok {
    @apply bg-app-green/10 text-app-green;
  }

  &.is-fail {
    @apply bg-app-primary/10 text-app-primary;
  }

  &.is-pending {
    @apply bg-app-surface-muted text-app-text-muted;
  }
}
</style>
