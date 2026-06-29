<script lang="ts" setup>
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue'
import type { SearchQuery } from '~/models'

const props = defineProps<{ query: SearchQuery }>()

const { t } = useI18n()
const { isLogged } = useUser()
const localePath = useLocalePath()

const { canSave, saveCurrent } = useSaveCurrentSearch(() => props.query)

const isOpen = ref(false)
const name = ref('')
const saving = ref(false)

const open = async () => {
  // Saving is tied to an account; an anonymous user is sent to sign in first.
  if (!isLogged.value) {
    await navigateTo(localePath('/sign'))
    return
  }
  name.value = ''
  isOpen.value = true
}

const close = () => {
  isOpen.value = false
}

const submit = async () => {
  if (!name.value.trim() || saving.value) return
  saving.value = true
  const created = await saveCurrent(name.value.trim())
  saving.value = false
  if (created) close()
}
</script>

<template>
  <button type="button" class="app-btn-alt save-btn" :disabled="!canSave" @click="open">
    <Icon name="heroicons-outline:bookmark" class="icon" />
    <span>{{ t('savedSearch.save') }}</span>
  </button>

  <TransitionRoot as="template" :show="isOpen">
    <Dialog as="div" class="dialog" @close="close">
      <TransitionChild
        as="template"
        enter="ease-out duration-300"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="ease-in duration-200"
        leave-from="opacity-100"
        leave-to="opacity-0"
      >
        <div class="overlay" />
      </TransitionChild>

      <div class="scroller">
        <div class="center">
          <TransitionChild
            as="template"
            enter="ease-out duration-300"
            enter-from="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            enter-to="opacity-100 translate-y-0 sm:scale-100"
            leave="ease-in duration-200"
            leave-from="opacity-100 translate-y-0 sm:scale-100"
            leave-to="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
          >
            <DialogPanel class="panel">
              <DialogTitle as="h3" class="title">
                {{ t('savedSearch.nameLabel') }}
              </DialogTitle>
              <form class="form" @submit.prevent="submit">
                <input
                  v-model="name"
                  type="text"
                  class="name-input"
                  :placeholder="t('savedSearch.namePlaceholder')"
                  :aria-label="t('savedSearch.nameLabel')"
                />
                <p class="hint">{{ t('savedSearch.alertHint') }}</p>
                <div class="actions">
                  <button type="submit" class="app-btn create-btn" :disabled="!name.trim() || saving">
                    {{ t('savedSearch.create') }}
                  </button>
                  <button type="button" class="app-btn-alt cancel-btn" @click="close">
                    {{ t('cancel') }}
                  </button>
                </div>
              </form>
            </DialogPanel>
          </TransitionChild>
        </div>
      </div>
    </Dialog>
  </TransitionRoot>
</template>

<style scoped>
.save-btn {
  @apply inline-flex items-center gap-2;

  &:disabled {
    @apply cursor-not-allowed opacity-50;
  }
}

.icon {
  @apply h-5 w-5;
}

.dialog {
  @apply relative z-10;
}

.overlay {
  @apply fixed inset-0 bg-gray-500/75 transition-opacity;
}

.scroller {
  @apply fixed inset-0 z-10 overflow-y-auto;
}

.center {
  @apply flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0;
}

.panel {
  @apply relative w-full transform overflow-hidden rounded-lg bg-app-surface px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:max-w-lg sm:p-6;
}

.title {
  @apply text-lg font-medium leading-6 text-app-text-strong;
}

.form {
  @apply mt-4 flex flex-col gap-3;
}

.name-input {
  @apply w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text;
}

.hint {
  @apply text-xs text-app-text-muted;
}

.actions {
  @apply mt-2 flex flex-row-reverse gap-2;
}

.create-btn {
  @apply w-auto;

  &:disabled {
    @apply cursor-not-allowed opacity-50;
  }
}

.cancel-btn {
  @apply w-auto;
}
</style>
