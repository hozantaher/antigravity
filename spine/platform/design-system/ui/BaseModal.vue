<script setup lang="ts">
import { Dialog, DialogPanel, TransitionChild, TransitionRoot } from '@headlessui/vue'

import { ModalSize } from '~/models'

interface Props {
  heading?: string
  subheading?: string
  isOpen?: boolean
  isClosable?: boolean
  size?: ModalSize
  bgColor?: string
  initialFocus?: HTMLElement
}

const props = withDefaults(defineProps<Props>(), {
  isOpen: false,
  isClosable: false,
  size: ModalSize.Medium,
  bgColor: '',
})

const emits = defineEmits(['update:isOpen', 'ctaClicked'])

const { t } = useI18n()

const isOpenLocal = computed({
  get: (): boolean => props.isOpen,
  set: (value: boolean): void => emits('update:isOpen', value),
})

const close = (): void => {
  if (!props.isClosable) return
  isOpenLocal.value = false
}
</script>

<template>
  <div>
    <slot name="trigger" />
    <TransitionRoot as="template" :show="isOpenLocal">
      <Dialog as="div" class="dialog" :initial-focus="initialFocus" @close="close">
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

        <div class="dialog-scroll">
          <div class="center-wrap">
            <TransitionChild
              as="template"
              enter="ease-out duration-300"
              enter-from="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              enter-to="opacity-100 translate-y-0 sm:scale-100"
              leave="ease-in duration-200"
              leave-from="opacity-100 translate-y-0 sm:scale-100"
              leave-to="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            >
              <DialogPanel class="panel" :style="{ 'background-color': bgColor, '--modal-w': props.size }">
                <div>
                  <slot name="heading" />
                  <div v-if="!$slots.heading" class="heading-block">
                    <h3 class="heading-title">
                      {{ heading }}
                    </h3>
                    <p v-if="subheading" class="heading-sub">
                      {{ subheading }}
                    </p>
                  </div>
                  <div class="body">
                    <slot />
                  </div>
                </div>
                <div v-if="isClosable" class="close-wrap">
                  <button type="button" class="app-icon-btn" @click="close">
                    <span class="visually-hidden">{{ t('close') }}</span>
                    <Icon name="heroicons-outline:x" class="close-icon" aria-hidden="false" />
                  </button>
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </TransitionRoot>
  </div>
</template>

<style scoped>
.dialog {
  @apply relative z-10;
}

.overlay {
  @apply fixed inset-0 bg-gray-500/75 transition-opacity;
}

.dialog-scroll {
  @apply fixed inset-0 z-10 overflow-y-auto;
}

.center-wrap {
  @apply flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0;
}

.panel {
  @apply w-full transform rounded-lg bg-app-surface px-4 pt-5 pb-4 text-left shadow-xl transition-all sm:my-8 sm:p-6 md:w-(--modal-w);
}

.heading-block {
  @apply border-b border-app-border pb-5;
}

.heading-title {
  @apply text-lg leading-6 font-medium text-app-text-strong;
}

.heading-sub {
  @apply mt-1 text-sm text-app-text-muted;
}

.body {
  @apply mt-3 sm:mt-5;
}

.close-wrap {
  @apply absolute top-0 right-0 pt-4 pr-4;
}

.visually-hidden {
  @apply sr-only;
}

.close-icon {
  @apply h-6 w-6;
}
</style>
