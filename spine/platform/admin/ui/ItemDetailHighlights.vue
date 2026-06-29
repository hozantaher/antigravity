<script lang="ts" setup>
import { Switch, SwitchGroup, SwitchLabel } from '@headlessui/vue'
import LocaleTabs from './LocaleTabs.vue'
import HighlightInput from './highlights/HighlightInput.vue'
import type { AdHighlight, Category, CategoryParam } from '~/models'

// Lazy: defer the vuedraggable (Sortable.js) chunk until the editor renders it under <ClientOnly>.
const draggable = defineAsyncComponent(() => import('vuedraggable'))

const { item, selectedLocale, showPresets, showOptions } = useAdminItem()
const { categoryParams, categories } = useCategories()
const { categoryLabel } = useAdminCategoryLabel()

const drag = ref(false)
const dragOptions = {
  animation: 200,
  group: 'description',
  disabled: false,
  ghostClass: 'ghost',
}

const highlights = computed({
  get: () => item.value?.highlights[selectedLocale.value] ?? [],
  set: newHighlights => (item.value!.highlights[selectedLocale.value] = newHighlights),
})

const params = computed(() => categoryParams.value.filter(c => !highlights.value.some(h => h.title === c.label)))

watch(
  selectedLocale,
  () => {
    if (item.value!.highlights[selectedLocale.value]) return

    item.value!.highlights[selectedLocale.value] = [{ title: '', value: '' }]
  },
  { immediate: true },
)

const getParamsByCategory = (cat: Category): CategoryParam[] =>
  categoryParams.value.filter(cp => cat.paramIds.includes(cp.id))

const onUsePreset = (cat: Category) => {
  item.value!.highlights[selectedLocale.value] = []
  const presetParams = getParamsByCategory(cat)
  for (const param of presetParams) {
    item.value!.highlights[selectedLocale.value]!.push({ paramId: param.id, title: param.label, value: '' })
  }
}

const onAddOption = (param: CategoryParam) => {
  item.value!.highlights[selectedLocale.value]!.push({ paramId: param.id, title: param.label, value: '' })
}

const addEmptyHighlight = () => {
  item.value!.highlights[selectedLocale.value]!.push({ title: '', value: '' })
}

const onRemoveHighlight = (highlight: AdHighlight) => {
  const index = item.value!.highlights[selectedLocale.value]!.indexOf(highlight)
  item.value!.highlights[selectedLocale.value]!.splice(index, 1)
}
</script>

<template>
  <div class="root">
    <h3 class="heading">Highlights</h3>

    <div v-if="params.length > 0" class="section">
      <SwitchGroup as="div" class="switch-group">
        <Switch v-model="showPresets" class="admin-switch" :class="{ 'is-on': showPresets }">
          <span class="admin-switch-thumb" :class="{ 'is-on': showPresets }" />
        </Switch>
        <SwitchLabel>
          <span class="switch-text">Show presets</span>
        </SwitchLabel>
      </SwitchGroup>

      <div v-if="showPresets" class="card-grid">
        <template v-for="cat in categories" :key="cat.id">
          <BaseConfirmation
            heading="Are you sure?"
            subheading="Using preset will remove current data"
            cta="Use preset"
            @on-confirm="onUsePreset(cat)"
          >
            <div class="preset-card">
              <div class="preset-title">
                {{ categoryLabel(cat) }}
              </div>
              <div class="preset-meta">contains {{ getParamsByCategory(cat).length }} params</div>
            </div>
          </BaseConfirmation>
        </template>
      </div>
    </div>

    <div v-if="params.length > 0" class="section">
      <SwitchGroup as="div" class="switch-group">
        <Switch v-model="showOptions" class="admin-switch" :class="{ 'is-on': showOptions }">
          <span class="admin-switch-thumb" :class="{ 'is-on': showOptions }" />
        </Switch>
        <SwitchLabel>
          <span class="switch-text">Show options</span>
        </SwitchLabel>
      </SwitchGroup>

      <div v-if="showOptions" class="card-grid">
        <template v-for="param in params" :key="param.id">
          <div class="option-card" @click="onAddOption(param)">
            <span class="option-label">
              {{ param.label }}
            </span>
          </div>
        </template>
      </div>
      <LocaleTabs />
    </div>

    <ClientOnly>
      <draggable
        v-model="highlights"
        :component-data="{ tag: 'ul', type: 'transition-group', name: !drag ? 'flip-list' : null }"
        v-bind="dragOptions"
        handle=".handle"
        item-key="id"
        @start="drag = true"
        @end="drag = false"
      >
        <template #item="{ element }">
          <HighlightInput
            :id="element.paramId"
            v-model:value="element.value"
            v-model:title="element.title"
            class="drag-row"
            :locale="selectedLocale"
            @remove="onRemoveHighlight(element)"
          />
        </template>
      </draggable>
    </ClientOnly>
    <div class="add-wrap">
      <div class="add-inner">
        <button type="button" class="app-btn-admin add-btn" @click="addEmptyHighlight">
          <Icon name="heroicons-solid:plus" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.root {
  @apply mb-2 flex flex-col gap-4;
}

.heading {
  @apply text-lg font-medium text-app-text-strong;
}

.section {
  @apply my-4 space-y-6;
}

.switch-group {
  @apply flex items-center gap-4;
}

.switch-text {
  @apply text-sm font-medium text-app-text-strong;
}

.card-grid {
  @apply grid grid-cols-2 gap-4 md:grid-cols-3;
}

.preset-card {
  @apply flex cursor-pointer flex-col items-start justify-center rounded-lg border border-app-border bg-app-surface px-3 py-3 text-sm font-medium text-app-text-strong sm:flex-1;
  @apply hover:bg-app-surface-muted focus:outline-none;
}

.preset-title {
  @apply whitespace-nowrap;
}

.preset-meta {
  @apply text-sm whitespace-nowrap text-app-text-muted;
}

.option-card {
  @apply flex cursor-pointer items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 py-3 text-sm font-medium uppercase text-app-text-strong sm:flex-1;
  @apply hover:bg-app-surface-muted focus:outline-none;
}

.option-label {
  @apply whitespace-nowrap;
}

.add-wrap {
  @apply pt-2;
}

.add-inner {
  @apply flex justify-center gap-4;
}

.add-btn {
  @apply w-full p-0 py-2 md:w-auto md:px-24;
}
</style>

<style>
.flip-list-move {
  transition: transform 0.5s;
}
.no-move {
  transition: transform 0s;
}
.ghost {
  @apply opacity-50;
}
.drag-row {
  @apply cursor-move py-2;
}
.drag-row i {
  @apply cursor-pointer;
}

/* Headless UI <Switch> renders its <button> without the component's scoped data-v
   attribute, so these must live in the unscoped block to actually apply. */
.admin-switch {
  @apply relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-app-text-muted transition-colors duration-200 ease-in-out;
  @apply focus:ring-2 focus:ring-app-primary/40 focus:ring-offset-2 focus:outline-none;
}
.admin-switch.is-on {
  @apply bg-app-primary;
}
.admin-switch-thumb {
  @apply pointer-events-none inline-block h-5 w-5 translate-x-0 transform rounded-full bg-app-surface shadow ring-0 transition duration-200 ease-in-out;
}
.admin-switch-thumb.is-on {
  @apply translate-x-5;
}
</style>
