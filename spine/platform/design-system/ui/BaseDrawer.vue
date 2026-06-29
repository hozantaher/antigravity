<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue'

// Right-anchored slide-over. Mirrors BaseModal's headlessui scaffold but slides on the x-axis
// instead of scaling — used for the notification feed and any contextual side panel. Width is a
// CSS var so a caller can widen it without an arbitrary utility (parity with BaseModal's --modal-w).
interface Props {
  heading?: string
  isOpen?: boolean
  isClosable?: boolean
  width?: string
}

const props = withDefaults(defineProps<Props>(), {
  isOpen: false,
  isClosable: true,
  width: '420px',
})

const emits = defineEmits(['update:isOpen'])

const { t } = useI18n()

const isOpenLocal = computed({
  get: (): boolean => props.isOpen,
  set: (value: boolean): void => emits('update:isOpen', value),
})

const close = (): void => {
  isOpenLocal.value = false
}
</script>

<template>
  <TransitionRoot as="template" :show="isOpenLocal">
    <Dialog as="div" class="drawer" @close="close">
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

      <div class="drawer-scroll">
        <div class="drawer-pos">
          <TransitionChild
            as="template"
            enter="transform transition ease-in-out duration-300"
            enter-from="translate-x-full"
            enter-to="translate-x-0"
            leave="transform transition ease-in-out duration-300"
            leave-from="translate-x-0"
            leave-to="translate-x-full"
          >
            <DialogPanel class="panel" :style="{ '--drawer-w': width }">
              <header class="panel-head">
                <slot name="heading">
                  <DialogTitle class="panel-title">{{ heading }}</DialogTitle>
                </slot>
                <button v-if="isClosable" type="button" class="app-icon-btn close-btn" @click="close">
                  <span class="visually-hidden">{{ t('close') }}</span>
                  <Icon name="heroicons-outline:x" class="close-icon" aria-hidden="true" />
                </button>
              </header>
              <div class="panel-body">
                <slot />
              </div>
              <footer v-if="$slots.footer" class="panel-foot">
                <slot name="footer" />
              </footer>
            </DialogPanel>
          </TransitionChild>
        </div>
      </div>
    </Dialog>
  </TransitionRoot>
</template>

<style scoped>
.drawer {
  @apply relative z-10;
}

.overlay {
  @apply fixed inset-0 bg-gray-500/75 transition-opacity;
}

.drawer-scroll {
  @apply fixed inset-0 overflow-hidden;
}

.drawer-pos {
  @apply pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10;
}

.panel {
  @apply pointer-events-auto flex w-screen max-w-(--drawer-w) flex-col bg-app-surface shadow-xl;
}

.panel-head {
  @apply flex items-center justify-between border-b border-app-border px-4 py-4;
}

.panel-title {
  @apply text-lg font-medium text-app-text-strong;
}

.close-icon {
  @apply h-6 w-6;
}

.panel-body {
  @apply flex-1 overflow-y-auto;
}

.panel-foot {
  @apply border-t border-app-border px-4 py-3;
}

.visually-hidden {
  @apply sr-only;
}
</style>
