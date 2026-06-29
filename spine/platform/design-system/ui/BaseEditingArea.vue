<script lang="ts" setup>
interface Props {
  heading: string
  subheading?: string
  valid?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  valid: true,
})

const emits = defineEmits(['onUpdate', 'onCancel'])

const { t } = useI18n()

const isEditing = ref(false)
const toggleEditing = useToggle(isEditing)

const cancel = () => {
  emits('onCancel')
  toggleEditing()
}

const update = () => {
  if (!props.valid) return
  emits('onUpdate')
  toggleEditing()
}
</script>

<template>
  <div class="card">
    <div class="head" :class="{ 'is-editing': isEditing }">
      <div>
        <h3 class="heading">
          {{ heading }}
        </h3>
        <p v-if="subheading" class="subheading">
          {{ subheading }}
        </p>
      </div>
      <button v-if="!isEditing" type="button" class="app-icon-btn">
        <Icon name="heroicons-solid:pencil" class="edit-icon" @click="toggleEditing()" />
      </button>
      <div v-else class="head-actions">
        <button type="button" class="app-btn-alt action-btn" @click="cancel">{{ t('cancel') }}</button>
        <button type="button" class="app-btn action-btn" :class="{ disabled: !valid }" @click="update">
          {{ t('save') }}
        </button>
      </div>
    </div>
    <div class="body">
      <div class="body-inner">
        <template v-if="isEditing">
          <slot name="editing" />
        </template>
        <slot v-else />
      </div>
    </div>
  </div>
</template>

<style scoped>
.card {
  @apply overflow-hidden rounded-lg border border-app-border bg-app-surface;
}

.head {
  @apply flex items-center justify-between px-6 py-3;

  &.is-editing {
    @apply bg-app-green/20;
  }
}

.heading {
  @apply text-lg leading-6 font-medium text-app-text-strong;
}

.subheading {
  @apply mt-1 max-w-2xl text-sm text-app-text-muted;
}

.edit-icon {
  @apply h-6 w-6;
}

.head-actions {
  @apply flex gap-1.5;
}

.action-btn {
  @apply w-auto;
}

.body {
  @apply border-t border-app-border;
}

.body-inner {
  @apply px-4 py-5 sm:px-6;
}
</style>
