<script setup lang="ts">
import { ModalSize } from '~/models'

// BaseModal
const modalOpen = ref(false)
const modalSize = ref<ModalSize>(ModalSize.Medium)
const modalSizes = [
  { label: 'Small', value: ModalSize.Small },
  { label: 'Wizard', value: ModalSize.Wizard },
  { label: 'Medium', value: ModalSize.Medium },
  { label: 'Large', value: ModalSize.Large },
]

// BaseConfirmation
const confirmCount = ref(0)

// BaseTransition
const transitionShow = ref(true)

// BaseEditingArea
const editName = ref('Jane Doe')

// Skeletons
const skelCount = ref(4)
const skelRows = ref(3)
</script>

<template>
  <PlaygroundSection
    id="overlays"
    title="Overlays & feedback"
    subtitle="Modals, confirmations, transitions, loading & empty states."
  >
    <PlaygroundSpecimen
      name="BaseModal"
      tag="Base + Headless"
      surface="white"
      center
      :chips="['isOpen', 'size', 'heading', 'isClosable', 'slot:trigger']"
    >
      <button type="button" class="app-btn pg-btn" @click="modalOpen = true">Open modal</button>
      <BaseModal
        v-model:is-open="modalOpen"
        :size="modalSize"
        is-closable
        heading="Modal heading"
        subheading="A Dialog wrapped with size presets and a closable header."
      >
        <p class="pg-modal-body">
          Body content goes here. Click the ✕, press Escape, or click the backdrop to dismiss.
        </p>
      </BaseModal>

      <template #controls>
        <div class="pg-ctl">
          <span class="pg-ctl-label">size</span>
          <div class="pg-seg">
            <button
              v-for="s in modalSizes"
              :key="s.label"
              type="button"
              class="pg-seg-btn"
              :class="{ 'is-active': modalSize === s.value }"
              @click="modalSize = s.value"
            >
              {{ s.label }}
            </button>
          </div>
        </div>
      </template>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="BaseConfirmation"
      tag="Base + Headless"
      surface="white"
      center
      :chips="['heading', 'subheading', 'cta', 'onConfirm', 'onCancel']"
    >
      <div class="pg-confirm">
        <BaseConfirmation
          heading="Delete item?"
          subheading="This action cannot be undone."
          cta="Delete"
          @on-confirm="confirmCount++"
        >
          <button type="button" class="app-btn-danger pg-btn">Delete…</button>
        </BaseConfirmation>
        <span class="pg-note">confirmed {{ confirmCount }}×</span>
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="BaseTransition" tag="Base" surface="white" center :chips="['unmount', 'slot']">
      <div class="pg-trans">
        <button type="button" class="app-btn-alt pg-btn" @click="transitionShow = !transitionShow">Toggle</button>
        <BaseTransition>
          <div v-if="transitionShow" class="pg-trans-box">fade + scale</div>
        </BaseTransition>
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="BaseEditingArea"
      tag="Base"
      surface="white"
      :chips="['heading', 'valid', 'onUpdate', 'onCancel', 'slot:editing']"
      description="Toggle the pencil to switch between view and edit modes."
    >
      <BaseEditingArea heading="Display name" subheading="Shown on your bids and invoices.">
        <p class="pg-edit-view">{{ editName }}</p>
        <template #editing>
          <BaseInput v-model:value="editName" type="text" label="Display name" />
        </template>
      </BaseEditingArea>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="Loading"
      tag="component"
      surface="white"
      description="Full-screen logo pulse, framed here."
    >
      <div class="pg-loading-frame">
        <Loading />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="NoItems" tag="component" surface="white" description="Empty-state placeholder.">
      <NoItems />
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="ItemsGridSkeletor" tag="skeleton" :chips="['count']">
      <ItemsGridSkeletor :count="skelCount" />
      <template #controls>
        <div class="pg-ctl">
          <span class="pg-ctl-label">count: {{ skelCount }}</span>
          <input v-model.number="skelCount" type="range" min="1" max="6" class="pg-range" />
        </div>
      </template>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="TableBodySkeletor" tag="skeleton" surface="white" :chips="['rows', 'cols']">
      <table class="pg-skel-table">
        <TableBodySkeletor :rows="skelRows" :cols="4" />
      </table>
      <template #controls>
        <div class="pg-ctl">
          <span class="pg-ctl-label">rows: {{ skelRows }}</span>
          <input v-model.number="skelRows" type="range" min="1" max="6" class="pg-range" />
        </div>
      </template>
    </PlaygroundSpecimen>
  </PlaygroundSection>
</template>

<style scoped>
.pg-btn {
  @apply w-auto;
}

.pg-modal-body {
  @apply text-sm text-gray-600;
}

.pg-confirm {
  @apply flex items-center gap-4;
}

.pg-note {
  @apply font-mono text-xs text-gray-500;
}

.pg-trans {
  @apply flex items-center gap-4;
}

.pg-trans-box {
  @apply rounded-lg bg-app-primary px-4 py-2 text-sm font-medium text-white;
}

.pg-edit-view {
  @apply text-sm text-gray-700;
}

.pg-loading-frame {
  @apply relative h-48 overflow-hidden rounded-lg bg-white ring-1 ring-gray-200;

  :deep(.loading) {
    @apply !h-full;
  }
}

.pg-skel-table {
  @apply min-w-full;
}

.pg-range {
  @apply w-40 cursor-pointer;
}
</style>
