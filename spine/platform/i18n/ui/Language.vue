<script lang="ts" setup>
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/vue'
import panarabFlagUrl from '~/assets/images/panarab_flag.png'

const { t, availableLocales, locale } = useI18n()
const switchLocalePath = useSwitchLocalePath()

// Navigate to the equivalent localized URL (keeps the current page + query); the i18n plugin
// lazy-loads the target locale's messages and persists the i18n_locale cookie on the way.
const current = computed({
  get: () => locale.value,
  set: code => {
    void navigateTo(switchLocalePath(code))
  },
})

const getFlagPrefix = (l: string) => {
  if (l === 'en') return 'us'
  return l
}
</script>

<template>
  <Listbox v-model="current" as="div">
    <div class="wrap">
      <ListboxButton class="trigger">
        <span class="trigger-value">
          <Icon v-if="locale !== 'ar'" :name="`flag:${getFlagPrefix(locale)}-4x3`" class="flag" />
          <img v-else :src="panarabFlagUrl" class="flag-panarab" alt="Pan-Arab" />
          <span class="label">{{ t(locale) }}</span>
        </span>
        <span class="arrow">
          <Icon name="heroicons-solid:selector" class="arrow-icon" aria-hidden="true" />
        </span>
      </ListboxButton>

      <transition
        leave-active-class="transition ease-in duration-100"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <ListboxOptions class="options">
          <ListboxOption v-for="l in availableLocales" :key="l" v-slot="{ active, selected }" as="template" :value="l">
            <li class="option" :class="{ 'is-active': active }">
              <div class="option-inner">
                <Icon v-if="l !== 'ar'" :name="`flag:${getFlagPrefix(l)}-4x3`" class="flag" />
                <img v-else :src="panarabFlagUrl" class="flag-panarab" alt="Pan-Arab" />
                <span class="option-label" :class="{ 'is-selected': selected }">
                  {{ t(l) }}
                </span>
              </div>

              <span v-if="selected" class="check" :class="{ 'is-active': active }">
                <Icon name="heroicons-solid:check" class="check-icon" aria-hidden="true" />
              </span>
            </li>
          </ListboxOption>
        </ListboxOptions>
      </transition>
    </div>
  </Listbox>
</template>

<style scoped>
.wrap {
  @apply relative;
}

.trigger {
  @apply relative w-full cursor-default rounded-lg border border-app-border bg-app-surface py-2 pl-3 pr-10 text-left focus:border-app-primary/30 focus:outline-none focus:ring-1 focus:ring-app-primary/30 sm:text-sm;
}

.trigger-value {
  @apply flex items-center;
}

.flag {
  @apply h-4 w-5.5;
}

.flag-panarab {
  @apply w-3.5;
}

.label {
  @apply ml-3 block truncate;
}

.option-label {
  @apply ml-3 block truncate font-normal;

  &.is-selected {
    @apply font-semibold;
  }
}

.arrow {
  @apply pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2;
}

.arrow-icon {
  @apply h-5 w-5 text-gray-400;
}

.options {
  @apply absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-app-border bg-app-surface py-1 text-base shadow-lg focus:outline-none sm:text-sm lg:w-45;
}

.option {
  @apply relative cursor-default select-none py-2 pl-3 pr-9 text-app-text-strong;

  &.is-active {
    @apply bg-app-primary text-white;
  }
}

.option-inner {
  @apply flex items-center;
}

.check {
  @apply absolute inset-y-0 right-0 flex items-center pr-4 text-app-primary;

  &.is-active {
    @apply text-white;
  }
}

.check-icon {
  @apply h-5 w-5;
}
</style>
