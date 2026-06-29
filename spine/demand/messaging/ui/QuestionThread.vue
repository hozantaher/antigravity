<script lang="ts" setup>
const { item } = useItemDetail()

const { t } = useI18n()

// Lazy, client-only fetch (mirrors SimilarItems): the thread panel hydrates after the main detail
// content paints. A newly asked question is pending → it correctly won't appear until published.
const { questions, total, page, pageSize, refresh } = useItemQuestions(() => item.value?.id)
</script>

<template>
  <div v-if="item" class="app-panel panel">
    <div class="app-panel-heading heading">
      {{ t('messaging.title') }}
    </div>
    <div class="app-panel-body form-wrap">
      <QuestionForm :item="item" @submitted="refresh" />
    </div>
    <ul v-if="questions.length" role="list" class="app-panel-body question-list">
      <QuestionRow v-for="question in questions" :key="question.id" :question="question" />
    </ul>
    <div v-else class="app-panel-body empty">
      <Icon name="heroicons-outline:chat-bubble-left-right" class="empty-icon" />
      <h3 class="empty-title">
        {{ t('messaging.empty') }}
      </h3>
      <p class="empty-desc">
        {{ t('messaging.emptyDesc') }}
      </p>
    </div>
    <BasePagination v-model:page="page" :total="total" :page-size="pageSize" class="question-pager" />
  </div>
</template>

<style scoped>
.panel {
  @apply mt-8 flow-root;
}

.heading {
  @apply flex items-center justify-between;
}

.form-wrap {
  @apply pb-2;
}

.question-list {
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

.question-pager {
  @apply pb-4;
}
</style>
