<script lang="ts" setup>
import type { OptionItem } from '~/models'
import { ModalSize } from '~/models'

const { availableLocales } = useI18n()
const { translateOtherLanguages, selectedLocale } = useAdminItem()
const config = useRuntimeConfig()

const localeOptions = computed(() => availableLocales.map<OptionItem>(l => ({ label: l.toUpperCase(), value: l })))

const deeplLanguageOptins = computed(() =>
  Object.keys(deeplLocales).map<OptionItem>(k => ({ label: k.toUpperCase(), value: k })),
)
const isOpen = ref(false)

const translateBtn = ref()

const selectedSource = ref('cz')

const openTranslateModal = () => {
  isOpen.value = true
  selectedSource.value = selectedLocale.value
}

const translateWithDeepl = () => {
  isOpen.value = false
  translateOtherLanguages(selectedSource.value)
  selectedSource.value = 'cz'
}
</script>

<template>
  <div class="mobile-select">
    <BaseSelect v-model:value="selectedLocale" :options="localeOptions" />
  </div>
  <div class="tabs-bar">
    <nav class="tabs-nav" aria-label="Language tab">
      <a
        v-for="locale in availableLocales"
        :key="locale"
        href="#"
        class="tab-link"
        :class="{ 'is-active': selectedLocale === locale }"
        @click="selectedLocale = locale"
        >{{ locale.toUpperCase() }}</a
      >
    </nav>
  </div>

  <BaseModal
    v-model:is-open="isOpen"
    :size="ModalSize.Small"
    heading="Translate with deepl"
    :initial-focus="translateBtn"
    is-closable
  >
    <template #trigger>
      <button
        v-if="config.public.deeplEnabled && Object.keys(deeplLocales).includes(selectedLocale)"
        type="button"
        class="app-btn-alt deepl-trigger"
        @click="openTranslateModal"
      >
        <Icon name="heroicons-outline:translate" class="deepl-icon" />
        Translate to other languages
      </button>
    </template>
    <div class="alert">
      <div class="alert-row">
        <div class="alert-icon-wrap">
          <Icon name="heroicons-outline:exclamation" class="alert-icon" aria-hidden="true" />
        </div>
        <div class="alert-body">
          <h3 class="alert-title">Attention needed</h3>
          <div class="alert-text">
            <p>This action will erase and replace data for all languages</p>
          </div>
        </div>
      </div>
    </div>
    <BaseSelect
      v-model:value="selectedSource"
      class="source-select"
      placeholder="Choose language"
      name="sourceCode"
      :options="deeplLanguageOptins"
      label="Source language"
      required
    />
    <div class="actions">
      <button type="button" class="app-btn-alt action-btn" @click="isOpen = false">Cancel</button>
      <button ref="translateBtn" type="button" class="app-btn-admin action-btn" @click="translateWithDeepl">
        Translate
      </button>
    </div>
  </BaseModal>
</template>

<style scoped>
.mobile-select {
  @apply md:hidden;
}

.tabs-bar {
  @apply hidden justify-between gap-4 md:flex md:flex-col;
}

.tabs-nav {
  @apply flex space-x-4 border-b border-app-border;
}

.tab-link {
  @apply -mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-app-text-muted hover:text-app-text;

  &.is-active {
    @apply border-app-primary text-app-text-strong;
  }
}

.deepl-trigger {
  @apply flex w-auto items-center gap-1 whitespace-nowrap;
}

.deepl-icon {
  @apply text-app-text;
}

.alert {
  @apply rounded-lg bg-app-red/10 p-4;
}

.alert-row {
  @apply flex;
}

.alert-icon-wrap {
  @apply flex-shrink-0;
}

.alert-icon {
  @apply h-6 w-6 text-app-red;
}

.alert-body {
  @apply ml-3;
}

.alert-title {
  @apply text-sm font-medium text-app-red;
}

.alert-text {
  @apply mt-2 text-sm text-app-red;
}

.source-select {
  @apply mt-4;
}

.actions {
  @apply flex gap-4;
}

.action-btn {
  @apply mt-8;
}
</style>
