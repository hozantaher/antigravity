<script setup lang="ts">
import { Dialog, DialogPanel, TransitionChild, TransitionRoot } from '@headlessui/vue'
import { useClipboard } from '@vueuse/core'
import type { ApiTokenCreated } from '~/models'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { createToken } = useApiTokens()

const name = ref('')
const submitting = ref(false)
const created = ref<ApiTokenCreated | null>(null)
const { copy, copied } = useClipboard()

const submit = async () => {
  const trimmed = name.value.trim()
  if (!trimmed || submitting.value) return
  submitting.value = true
  try {
    const res = await createToken(trimmed)
    if (res) created.value = res
  } finally {
    submitting.value = false
  }
}

// Reset after the leave transition so a reopened dialog starts on the form again.
const reset = () => {
  name.value = ''
  created.value = null
  submitting.value = false
}
</script>

<template>
  <TransitionRoot as="template" :show="open">
    <Dialog as="div" class="dialog" @close="emit('close')">
      <TransitionChild
        as="template"
        enter="ease-out duration-200"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="ease-in duration-150"
        leave-from="opacity-100"
        leave-to="opacity-0"
      >
        <div class="overlay" />
      </TransitionChild>

      <div class="wrap">
        <TransitionChild
          as="template"
          enter="ease-out duration-200"
          enter-from="opacity-0 scale-95"
          enter-to="opacity-100 scale-100"
          leave="ease-in duration-150"
          leave-from="opacity-100 scale-100"
          leave-to="opacity-0 scale-95"
          @after-leave="reset"
        >
          <DialogPanel class="panel">
            <template v-if="!created">
              <h2 class="title">Create API token</h2>
              <p class="hint">Name this token so you can recognise it later. It authenticates as you.</p>
              <input
                v-model="name"
                class="name-input"
                data-cy="api-token-name-input"
                placeholder="e.g. Partner integration"
                maxlength="100"
                @keyup.enter="submit"
              />
              <div class="actions">
                <button type="button" class="app-text-btn" @click="emit('close')">Cancel</button>
                <button
                  type="button"
                  class="app-btn-admin"
                  :disabled="submitting || !name.trim()"
                  data-cy="api-token-submit-button"
                  @click="submit"
                >
                  Create
                </button>
              </div>
            </template>

            <template v-else>
              <h2 class="title">Copy your token</h2>
              <p class="warning">
                For security this token is shown only once. Copy it now — you won't be able to see it again.
              </p>
              <code class="token" data-cy="api-token-value">{{ created.token }}</code>
              <div class="actions">
                <button type="button" class="app-text-btn" data-cy="api-token-done-button" @click="emit('close')">
                  Done
                </button>
                <button
                  type="button"
                  class="app-btn-admin"
                  data-cy="api-token-copy-button"
                  @click="copy(created.token)"
                >
                  {{ copied ? 'Copied' : 'Copy' }}
                </button>
              </div>
            </template>
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>

<style scoped>
.dialog {
  @apply relative z-50;
}

.overlay {
  @apply fixed inset-0 bg-app-text-strong/40;
}

.wrap {
  @apply fixed inset-0 flex items-center justify-center p-4;
}

.panel {
  @apply w-full max-w-md rounded-lg border border-app-border bg-app-surface p-6 shadow-xl;
}

.title {
  @apply text-lg font-semibold text-app-text-strong;
}

.hint {
  @apply mt-1 text-sm text-app-text-muted;
}

.warning {
  @apply mt-1 text-sm text-app-red;
}

.name-input {
  @apply mt-4 w-full rounded-lg border border-app-border-strong bg-app-surface px-3 py-2 text-sm text-app-text-strong;

  &:focus {
    @apply border-app-primary ring-1 ring-app-primary outline-none;
  }
}

.token {
  @apply mt-4 block w-full rounded-lg bg-app-surface-muted p-3 font-mono text-sm break-all text-app-text-strong;
}

.actions {
  @apply mt-6 flex items-center justify-end gap-3;
}
</style>
