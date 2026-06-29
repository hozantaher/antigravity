<script lang="ts" setup>
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue'

defineProps<{
  heading?: string
  subheading?: string
  cta?: string
}>()

const emits = defineEmits(['onConfirm', 'onCancel'])

const { t } = useI18n()

const isOpen = ref(false)

const open = () => {
  isOpen.value = true
}

const confirm = () => {
  isOpen.value = false
  emits('onConfirm')
}

const cancel = () => {
  isOpen.value = false
  emits('onCancel')
}
</script>

<template>
  <div @click.prevent="open">
    <slot />
  </div>
  <TransitionRoot as="template" :show="isOpen">
    <Dialog as="div" class="dialog" @close="cancel">
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
              <div class="close-wrap">
                <button type="button" class="app-icon-btn" @click="cancel">
                  <Icon name="heroicons-outline:x" class="close-icon" aria-hidden="true" />
                </button>
              </div>
              <div class="body">
                <div class="icon-circle">
                  <Icon name="heroicons-outline:exclamation" class="warn-icon" aria-hidden="true" />
                </div>
                <div class="texts">
                  <DialogTitle as="h3" class="title">
                    {{ heading ?? t('confirm.title') }}
                  </DialogTitle>
                  <div class="desc-wrap">
                    <p class="desc">
                      {{ subheading ?? t('confirm.desc') }}
                    </p>
                  </div>
                </div>
              </div>
              <div class="actions">
                <button type="button" class="app-btn-danger confirm-btn" @click="confirm">
                  {{ cta ?? t('confirm.cta') }}
                </button>
                <button type="button" class="app-btn-alt cancel-btn" @click="cancel">
                  {{ t('confirm.cancel') }}
                </button>
              </div>
            </DialogPanel>
          </TransitionChild>
        </div>
      </div>
    </Dialog>
  </TransitionRoot>
</template>

<style scoped>
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
  @apply relative transform overflow-hidden rounded-lg bg-app-surface px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6;
}

.close-wrap {
  @apply absolute right-0 top-0 hidden pr-4 pt-4 sm:block;
}

.close-icon {
  @apply h-6 w-6;
}

.body {
  @apply sm:flex sm:items-start;
}

.icon-circle {
  @apply mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-app-red/10 sm:mx-0 sm:h-10 sm:w-10;
}

.warn-icon {
  @apply h-6 w-6 text-app-red;
}

.texts {
  @apply mt-3 text-center sm:ml-4 sm:mt-0 sm:text-left;
}

.title {
  @apply text-lg font-medium leading-6 text-app-text-strong;
}

.desc-wrap {
  @apply mt-2;
}

.desc {
  @apply text-sm text-app-text-muted;
}

.actions {
  @apply mt-5 sm:mt-4 sm:flex sm:flex-row-reverse;
}

.confirm-btn {
  @apply ml-2 w-auto;
}

.cancel-btn {
  @apply w-auto;
}
</style>
