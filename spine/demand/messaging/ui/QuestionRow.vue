<script lang="ts" setup>
import type { PublicQuestion } from '~/models'

// Public thread row: the asker is anonymized (PublicQuestion carries no userId), so the row shows
// a generic "Buyer" label rather than identifying who asked.
defineProps<{
  question: PublicQuestion
}>()

const { t } = useI18n()
</script>

<template>
  <li class="question-row">
    <div class="question-line">
      <span class="avatar">
        <Icon name="heroicons-outline:user" class="avatar-icon" />
      </span>
      <div class="question-info">
        <p class="question-name">
          {{ t('messaging.asker') }}
        </p>
        <p class="question-date">
          {{ formatDate(question.created, 'DD.MM.yyyy HH:mm') }}
        </p>
      </div>
    </div>
    <p class="question-body">
      {{ question.body }}
    </p>
    <div v-if="question.answer" class="answer">
      <p class="answer-label">
        <Icon name="heroicons-outline:chat-bubble-left-right" class="answer-icon" />
        {{ t('messaging.answer') }}
      </p>
      <p class="answer-body">
        {{ question.answer }}
      </p>
    </div>
  </li>
</template>

<style scoped>
.question-row {
  @apply py-4;
}

.question-line {
  @apply flex items-center space-x-4;
}

.avatar {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-500;
}

.avatar-icon {
  @apply h-5 w-5 text-white;
}

.question-info {
  @apply min-w-0 flex-1;
}

.question-name {
  @apply truncate text-sm font-medium text-app-text-strong;
}

.question-date {
  @apply truncate text-sm text-app-text-muted;
}

.question-body {
  @apply mt-2 text-sm whitespace-pre-line text-app-text;
}

.answer {
  @apply mt-3 rounded-lg border border-app-border bg-app-surface-muted p-3;
}

.answer-label {
  @apply flex items-center gap-1 text-xs font-medium text-app-text-muted;
}

.answer-icon {
  @apply text-app-text-muted;
}

.answer-body {
  @apply mt-1 text-sm whitespace-pre-line text-app-text-strong;
}
</style>
