<script setup lang="ts">
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Popover,
  PopoverButton,
  PopoverPanel,
  Switch,
} from '@headlessui/vue'

const dialogOpen = ref(false)
const listboxValue = ref('auction')
const listboxOptions = ['auction', 'ad', 'sold']
const menuActions = ['Edit', 'Duplicate', 'Archive']
const switchOn = ref(true)
</script>

<template>
  <PlaygroundSection id="headless" title="Headless UI" subtitle="@headlessui/vue primitives used in the app.">
    <PlaygroundSpecimen
      name="Dialog"
      tag="@headlessui/vue"
      surface="white"
      center
      description="The app wraps this in BaseModal / BaseConfirmation."
    >
      <button type="button" class="app-btn pg-btn" @click="dialogOpen = true">Open dialog</button>
      <Dialog :open="dialogOpen" @close="dialogOpen = false">
        <div class="hl-dialog">
          <div class="hl-overlay" aria-hidden="true" />
          <div class="hl-dialog-scroll">
            <DialogPanel>
              <div class="hl-panel">
                <DialogTitle class="hl-title">Raw Dialog</DialogTitle>
                <p class="hl-text">A minimal headless Dialog — focus trap, Escape & click-outside built in.</p>
                <button type="button" class="app-btn pg-btn" @click="dialogOpen = false">Close</button>
              </div>
            </DialogPanel>
          </div>
        </div>
      </Dialog>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="Menu"
      tag="@headlessui/vue"
      surface="white"
      description="Used by UserMenuAvatar. Click to open."
    >
      <Menu>
        <div class="hl-menu">
          <MenuButton class="hl-trigger">Actions</MenuButton>
          <MenuItems class="hl-menu-items">
            <MenuItem v-for="m in menuActions" :key="m" v-slot="{ active }">
              <button type="button" class="hl-menu-item" :class="{ 'is-active': active }">{{ m }}</button>
            </MenuItem>
          </MenuItems>
        </div>
      </Menu>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="Listbox"
      tag="@headlessui/vue"
      surface="white"
      description="Used by Language. Bound to a single value."
    >
      <Listbox v-model="listboxValue">
        <div class="hl-listbox">
          <ListboxButton class="hl-trigger">{{ listboxValue }}</ListboxButton>
          <ListboxOptions class="hl-listbox-options">
            <ListboxOption v-for="o in listboxOptions" :key="o" v-slot="{ active, selected }" :value="o" as="template">
              <li class="hl-listbox-option" :class="{ 'is-active': active, 'is-selected': selected }">{{ o }}</li>
            </ListboxOption>
          </ListboxOptions>
        </div>
      </Listbox>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="Popover"
      tag="@headlessui/vue"
      surface="white"
      description="Used by the Header mobile menu."
    >
      <Popover>
        <div class="hl-popover">
          <PopoverButton class="hl-trigger">Toggle popover</PopoverButton>
          <PopoverPanel class="hl-popover-panel">
            <p class="hl-text">Popover content rendered in place, dismissed on outside click.</p>
          </PopoverPanel>
        </div>
      </Popover>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="Switch"
      tag="@headlessui/vue"
      surface="white"
      center
      description="Used by admin highlight toggles."
    >
      <div class="hl-switch-row">
        <Switch v-model="switchOn" class="hl-switch" :class="{ 'is-on': switchOn }">
          <span class="hl-switch-thumb" :class="{ 'is-on': switchOn }" />
        </Switch>
        <span class="hl-switch-label">{{ switchOn ? 'On' : 'Off' }}</span>
      </div>
    </PlaygroundSpecimen>
  </PlaygroundSection>
</template>

<style scoped>
.pg-btn {
  @apply w-auto;
}

.hl-trigger {
  @apply inline-flex cursor-pointer items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50;
}

.hl-text {
  @apply text-sm text-gray-600;
}

/* Dialog */
.hl-dialog {
  @apply relative z-10;
}

.hl-overlay {
  @apply fixed inset-0 bg-gray-500/75;
}

.hl-dialog-scroll {
  @apply fixed inset-0 flex items-center justify-center p-4;
}

.hl-panel {
  @apply w-full max-w-sm rounded-lg bg-white p-6 shadow-xl;
}

.hl-title {
  @apply text-lg font-semibold text-gray-900;
}

.hl-panel .hl-text {
  @apply mt-1 mb-4;
}

/* Menu */
.hl-menu {
  @apply relative inline-block;
}

.hl-menu-items {
  @apply absolute left-0 z-10 mt-2 w-44 origin-top-left rounded-lg bg-white py-1 shadow-lg ring-1 ring-black/5 focus:outline-none;
}

.hl-menu-item {
  @apply block w-full cursor-pointer px-4 py-2 text-left text-sm text-gray-700;

  &.is-active {
    @apply bg-app-red/90 text-white;
  }
}

/* Listbox */
.hl-listbox {
  @apply relative inline-block;
}

.hl-listbox-options {
  @apply absolute left-0 z-10 mt-2 w-44 overflow-hidden rounded-lg bg-white py-1 shadow-lg ring-1 ring-black/5 focus:outline-none;
}

.hl-listbox-option {
  @apply cursor-pointer px-4 py-2 text-sm text-gray-700;

  &.is-active {
    @apply bg-app-red/90 text-white;
  }

  &.is-selected {
    @apply font-semibold;
  }
}

/* Popover */
.hl-popover {
  @apply relative inline-block;
}

.hl-popover-panel {
  @apply absolute left-0 z-10 mt-2 w-64 rounded-lg bg-white p-4 shadow-lg ring-1 ring-black/5;
}

/* Switch */
.hl-switch-row {
  @apply flex items-center gap-3;
}

.hl-switch-label {
  @apply text-sm font-medium text-gray-700;
}
</style>

<style>
/* Headless UI <Switch> renders its <button> without this component's scoped data-v
   attribute, so the toggle styles must be unscoped to apply. */
.hl-switch {
  @apply relative inline-flex h-6 w-11 cursor-pointer items-center rounded-full bg-app-text-muted transition-colors;
}
.hl-switch.is-on {
  @apply bg-app-primary;
}
.hl-switch-thumb {
  @apply inline-block h-4 w-4 translate-x-1 rounded-full bg-white shadow-sm transition-transform;
}
.hl-switch-thumb.is-on {
  @apply translate-x-6;
}
</style>
