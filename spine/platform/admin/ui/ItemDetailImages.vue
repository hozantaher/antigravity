<script lang="ts" setup>
// Lazy: vuedraggable (Sortable.js) only matters once the editor is open, and it's used inside
// <ClientOnly>, so defer its chunk off the admin item page's initial load.
const draggable = defineAsyncComponent(() => import('vuedraggable'))

const { item, images, uploadImages } = useAdminItem()
const { getMediumImage, getImageUrl } = useImageProcessing()

const onFileSelected = (e: any, is360 = false) => {
  const files = e.target.files || e.dataTransfer.files
  if (!files.length) return
  uploadImages([...files], is360)
  // Reset the input so re-picking the same file fires change again (e.g. after a remove).
  if (e.target?.files) e.target.value = ''
}

const preventDefaults = (e: any) => e.preventDefault()

const events = ['dragenter', 'dragover', 'dragleave', 'drop']

const removeImage = (url: string) => {
  images.value = images.value.filter(u => u !== url)
}

const remove360Image = (url: string) => {
  item.value!.images360 = item.value!.images360.filter(u => u !== url)
}

const draggableImages = computed({
  get: () => images.value.map((url, index) => ({ url, order: index + 1 })),
  set: newImages => {
    images.value = newImages.map(i => i.url)
  },
})

const draggable360Images = computed({
  get: () => (item.value?.images360 ?? []).map((url, index) => ({ url, order: index + 1 })),
  set: newImages => {
    item.value!.images360 = newImages.map(i => i.url)
  },
})

onMounted(() => {
  events.forEach(eventName => {
    document.body.addEventListener(eventName, preventDefaults)
  })
})

onUnmounted(() => {
  events.forEach(eventName => {
    document.body.removeEventListener(eventName, preventDefaults)
  })
})
const drag = ref(false)
const dragOptions = {
  animation: 200,
  group: 'description',
  disabled: false,
  ghostClass: 'ghost',
}
</script>

<template>
  <div class="root">
    <h1 class="gallery-title">Item gallery</h1>
    <template v-if="item">
      <ClientOnly>
        <draggable
          v-model="draggableImages"
          :component-data="{ tag: 'ul', type: 'transition-group', name: !drag ? 'flip-list' : null }"
          v-bind="dragOptions"
          item-key="order"
          class="gallery-grid"
          @start="drag = true"
          @end="drag = false"
        >
          <template #item="{ element }">
            <div class="gallery-grid-item">
              <div class="image-frame group">
                <img :src="getMediumImage(element.url)" alt="" class="image" />
                <BaseConfirmation @on-confirm="removeImage(element.url)">
                  <button type="button" class="remove-btn">
                    <Icon name="heroicons-solid:trash" class="remove-icon" />
                  </button>
                </BaseConfirmation>
              </div>
            </div>
          </template>
        </draggable>
      </ClientOnly>
      <div class="dropzone-wrap">
        <div class="dropzone" @dragover.prevent @drop.prevent="onFileSelected($event)">
          <div class="dropzone-inner">
            <svg class="dropzone-svg" stroke="currentColor" fill="none" viewBox="0 0 48 48" aria-hidden="true">
              <path
                d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <div class="dropzone-label-row">
              <label for="file-upload" class="dropzone-label">
                <span>Upload a file</span>
                <input
                  id="file-upload"
                  name="file-upload"
                  type="file"
                  class="field-input"
                  multiple
                  @change="onFileSelected($event)"
                />
              </label>
              <p class="dropzone-hint-inline">or drag and drop</p>
            </div>
            <p class="dropzone-note">PNG, JPG, GIF up to 20MB</p>
          </div>
        </div>
      </div>
      <div class="section-360">
        <h1 class="section-360-title">360° Image</h1>
        <ClientOnly>
          <draggable
            v-model="draggable360Images"
            :component-data="{ tag: 'ul', type: 'transition-group', name: !drag ? 'flip-list' : null }"
            v-bind="dragOptions"
            item-key="order"
            class="gallery-grid-single"
            @start="drag = true"
            @end="drag = false"
          >
            <template #item="{ element }">
              <div class="gallery-grid-single-item">
                <div class="image-frame group">
                  <img :src="getImageUrl(element.url, { width: 500 })" alt="" class="image" />
                  <BaseConfirmation @on-confirm="remove360Image(element.url)">
                    <button type="button" class="remove-btn">
                      <Icon name="heroicons-solid:trash" class="remove-icon" />
                    </button>
                  </BaseConfirmation>
                </div>
              </div>
            </template>
          </draggable>
        </ClientOnly>

        <div class="dropzone" @dragover.prevent @drop.prevent="onFileSelected($event, true)">
          <div class="dropzone-inner">
            <svg class="dropzone-svg" stroke="currentColor" fill="none" viewBox="0 0 48 48" aria-hidden="true">
              <path
                d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <div class="dropzone-label-row">
              <label for="file-upload-360" class="dropzone-label">
                <span>Upload a file</span>
                <input
                  id="file-upload-360"
                  name="file-upload-360"
                  type="file"
                  class="field-input"
                  :multiple="false"
                  @change="onFileSelected($event, true)"
                />
              </label>
              <p class="dropzone-hint-inline">or drag and drop</p>
            </div>
            <p class="dropzone-note">PNG, JPG, GIF up to 20MB</p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.root {
  @apply pb-30;
}

.gallery-title {
  @apply m-4 mt-6 text-lg font-medium text-app-text-strong;
}

.gallery-grid {
  @apply grid grid-cols-1 p-8 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-2;
}

.gallery-grid-item {
  @apply relative mx-4 my-4 first:col-span-1 sm:first:col-span-2 md:first:col-span-3 xl:first:col-span-2;
}

.image-frame {
  @apply block w-full overflow-hidden rounded-lg bg-app-surface-muted focus-within:ring-2 focus-within:ring-app-primary focus-within:ring-offset-2;
}

.image {
  @apply pointer-events-none w-full object-cover group-hover:opacity-75;
}

.remove-btn {
  @apply absolute top-2 right-2 rounded-lg bg-app-surface/80 p-1 focus:outline-none;
}

.remove-icon {
  @apply h-6 w-6 cursor-pointer text-app-red;
}

.dropzone-wrap {
  @apply my-6 px-4;
}

.dropzone {
  @apply flex w-full justify-center rounded-lg border-2 border-dashed border-app-border-strong px-6 pt-5 pb-6;
}

.dropzone-inner {
  @apply space-y-1 text-center;
}

.dropzone-svg {
  @apply mx-auto h-12 w-12 text-app-text-muted;
}

.dropzone-label-row {
  @apply flex text-sm text-app-text-muted;
}

.dropzone-label {
  @apply relative cursor-pointer rounded-lg font-medium text-app-primary focus-within:ring-2 focus-within:ring-app-primary focus-within:ring-offset-2 focus-within:outline-none hover:text-app-primary-hover;
}

.dropzone-hint-inline {
  @apply pl-1;
}

.dropzone-note {
  @apply text-xs text-app-text-muted;
}

.section-360 {
  @apply mt-2 border-t border-app-border px-4 py-6;
}

.section-360-title {
  @apply mb-6 text-lg font-medium text-app-text-strong;
}

.gallery-grid-single {
  @apply grid grid-cols-1 p-8;
}

.gallery-grid-single-item {
  @apply relative mx-4 my-4;
}

.field-input {
  @apply sr-only;
}
</style>
