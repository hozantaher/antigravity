<script setup lang="ts">
import { reactive, watch } from 'vue'
import type { Question } from '~/models'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { questions, total, loading, fetchPage, answer, setStatus, dispose } = useQuestionQueue()

const { page, pageSize } = useAdminPagedList({
  fetch: ({ page, pageSize, q }) => fetchPage({ page, pageSize, q }),
  dispose,
})

// Per-row answer drafts, seeded from any existing answer so editing shows current text.
const drafts = reactive<Record<string, string>>({})
watch(questions, list => {
  for (const q of list ?? []) if (!(q.id in drafts)) drafts[q.id] = q.answer ?? ''
})

const submitAnswer = (q: Question) => {
  const text = (drafts[q.id] ?? '').trim()
  if (text) answer(q, text)
}
</script>

<template>
  <div class="app-section page">
    <div class="app-container">
      <div class="header">
        <div class="header-main">
          <h1 class="title">
            Questions <span class="count">({{ questions === undefined ? '--' : total }})</span>
          </h1>
          <p class="subtitle">Buyer questions across all listings. Answer to auto-publish, or hide.</p>
        </div>
      </div>

      <div class="listing" :class="{ 'is-loading': loading && questions }">
        <ul v-if="questions?.length" role="list" class="questions">
          <li v-for="q in questions" :key="q.id" class="question">
            <div class="question-head">
              <NuxtLink :to="`/admin/item/${q.itemId}`" target="_blank" class="item-link">{{ q.itemId }}</NuxtLink>
              <NuxtLink :to="`/admin/users/${q.userId}`" target="_blank" class="asker">{{
                parseUserIdentifier(q.userId)
              }}</NuxtLink>
              <span class="date">{{ formatDate(q.created, 'DD.MM.yyyy HH:mm') }}</span>
              <span class="status" :class="`is-${q.status}`">{{ q.status }}</span>
            </div>
            <p class="body">{{ q.body }}</p>
            <textarea v-model="drafts[q.id]" class="answer-input" rows="2" placeholder="Write an answer…" />
            <div class="actions">
              <button type="button" class="app-btn-admin answer-btn" @click="submitAnswer(q)">
                Answer &amp; publish
              </button>
              <button
                v-if="q.status !== 'published'"
                type="button"
                class="app-btn-alt status-btn"
                @click="setStatus(q, 'published')"
              >
                Publish
              </button>
              <BaseConfirmation v-if="q.status !== 'hidden'" @on-confirm="setStatus(q, 'hidden')">
                <button type="button" class="app-btn-danger status-btn">Hide</button>
              </BaseConfirmation>
            </div>
          </li>
        </ul>
        <TableBodySkeletor v-if="!questions" :rows="5" :cols="1" />
        <NoItems v-if="questions?.length === 0" class="no-items" />
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
  @apply mt-8 border border-app-border bg-app-surface transition-opacity duration-200 rounded-lg;

  &.is-loading {
    @apply pointer-events-none opacity-60;
  }
}

.questions {
  @apply divide-y divide-app-border px-4;
}

.question {
  @apply py-4;
}

.question-head {
  @apply flex flex-wrap items-center gap-3 text-sm;
}

.item-link {
  @apply font-mono text-xs text-app-text-muted;

  &:hover {
    @apply underline;
  }
}

.asker {
  @apply font-medium text-app-primary;
}

.date {
  @apply text-app-text-muted;
}

.status {
  @apply inline-flex items-center rounded-full bg-app-surface-muted px-2.5 py-0.5 text-xs font-medium text-app-text-muted;

  &.is-published {
    @apply bg-app-green text-white;
  }

  &.is-hidden {
    @apply bg-app-primary text-white;
  }

  &.is-pending {
    @apply bg-app-amber text-white;
  }
}

.body {
  @apply mt-2 text-sm whitespace-pre-line text-app-text;
}

.answer-input {
  @apply mt-3 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text;

  &:focus {
    @apply border-app-border-strong outline-none;
  }
}

.actions {
  @apply mt-3 flex flex-wrap gap-3;
}

.answer-btn {
  @apply w-auto;
}

.status-btn {
  @apply w-auto;
}

.no-items {
  @apply py-16;
}
</style>
