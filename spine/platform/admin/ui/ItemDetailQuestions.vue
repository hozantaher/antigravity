<script lang="ts" setup>
import type { Question } from '~/models'

const { item } = useAdminItem()
const { questions, loading, load, answerQuestion, setQuestionStatus, dispose } = useAdminQuestions()

const pageSize = 10
const page = ref(1)

// The repo returns newest-first (created desc); keep that order. Paginate the local array so it
// reflects unsaved answers/status.
const ordered = computed(() => questions.value)
const total = computed(() => ordered.value.length)
const pageOffset = computed(() => (page.value - 1) * pageSize)
const pageQuestions = computed(() => ordered.value.slice(pageOffset.value, page.value * pageSize))

// Per-row answer drafts (keyed by question id), seeded from any existing answer when the list loads.
const drafts = reactive<Record<string, string>>({})

const submitAnswer = async (q: Question) => {
  const answer = (drafts[q.id] ?? '').trim()
  if (!answer) return
  await answerQuestion(q.id, answer)
}

watch(
  () => item.value?.id,
  id => load(id),
  { immediate: true },
)

// Seed drafts from existing answers so editing an answered question shows its current text.
watch(questions, list => {
  for (const q of list) if (!(q.id in drafts)) drafts[q.id] = q.answer ?? ''
})

watch(total, () => {
  const maxPage = Math.max(1, Math.ceil(total.value / pageSize))
  if (page.value > maxPage) page.value = maxPage
})

// Clear the shared admin-questions state when leaving the editor so a stale list doesn't bleed
// into the next item opened.
onBeforeUnmount(dispose)
</script>

<template>
  <div v-if="item" class="layout">
    <div class="app-panel panel">
      <div class="app-panel-heading heading">Questions</div>
      <ul v-if="pageQuestions.length" role="list" class="app-panel-body questions">
        <li v-for="q in pageQuestions" :key="q.id" class="question">
          <div class="question-head">
            <NuxtLinkLocale :to="`/admin/users/${q.userId}`" target="_blank">
              <span class="asker">{{ parseUserIdentifier(q.userId) }}</span>
            </NuxtLinkLocale>
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
              @click="setQuestionStatus(q.id, 'published')"
            >
              Publish
            </button>
            <BaseConfirmation v-if="q.status !== 'hidden'" @on-confirm="setQuestionStatus(q.id, 'hidden')">
              <button type="button" class="app-btn-danger status-btn">Hide</button>
            </BaseConfirmation>
          </div>
        </li>
      </ul>
      <div v-else-if="loading" class="app-panel-body empty">
        <Icon name="mdi:loading" class="empty-icon is-spin" />
        <p class="empty-text">Loading…</p>
      </div>
      <div v-else class="app-panel-body empty">
        <Icon name="heroicons-outline:chat-bubble-left-right" class="empty-icon" />
        <h3 class="empty-title">No questions</h3>
        <p class="empty-text">There are no questions yet</p>
      </div>
      <BasePagination
        v-model:page="page"
        :total="total"
        :page-size="pageSize"
        variant="admin"
        class="questions-pager"
      />
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

.questions {
  @apply divide-y divide-app-border;
}

.question {
  @apply py-4;
}

.question-head {
  @apply flex flex-wrap items-center gap-3 text-sm;
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

.empty {
  @apply text-center;
}

.empty-icon {
  @apply mx-auto h-12 w-12 text-app-text-muted;

  &.is-spin {
    @apply animate-spin;
  }
}

.empty-title {
  @apply mt-2 font-medium text-app-text-strong;
}

.empty-text {
  @apply mt-1 text-app-text-muted;
}

.questions-pager {
  @apply pb-4;
}

.info {
  @apply order-1 md:order-2;
}
</style>
