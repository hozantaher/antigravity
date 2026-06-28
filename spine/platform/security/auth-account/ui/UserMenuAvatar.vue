<script lang="ts" setup>
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/vue'

// Header anchors the avatar top-right (open down); the admin sidebar footer
// anchors it bottom-left, so the dropdown must open up to stay on screen.
const { placement = 'bottom-end' } = defineProps<{ placement?: 'bottom-end' | 'top-start' }>()

const { t } = useI18n()

const { user, isLogged, isAdmin, signOut } = useUser()
</script>

<template>
  <div>
    <NuxtLinkLocale v-if="!isLogged" to="/sign">
      <Icon name="heroicons-outline:user-circle" class="user-icon" />
    </NuxtLinkLocale>
    <!-- Profile dropdown -->
    <Menu v-else v-slot="{ close }" as="div" class="menu">
      <div>
        <MenuButton class="menu-button">
          <LettersAvatar :name="user!.fullName" />
        </MenuButton>
      </div>
      <BaseTransition>
        <MenuItems class="menu-items" :class="{ 'is-top-start': placement === 'top-start' }">
          <MenuItem v-slot="{ active }">
            <NuxtLinkLocale to="/profile" class="menu-link" :class="{ 'is-active': active }" @click="close">
              {{ t('accountTitle') }}
            </NuxtLinkLocale>
          </MenuItem>
          <MenuItem v-slot="{ active }">
            <NuxtLinkLocale
              to="/favorites"
              class="menu-link menu-link-favorites"
              :class="{ 'is-active': active }"
              @click="close"
            >
              {{ t('favorite') }}
            </NuxtLinkLocale>
          </MenuItem>
          <MenuItem v-if="isAdmin" v-slot="{ active }">
            <NuxtLinkLocale to="/admin/users" class="menu-link" :class="{ 'is-active': active }" @click="close">
              Admin
            </NuxtLinkLocale>
          </MenuItem>
          <MenuItem v-slot="{ active }">
            <a
              href="#"
              class="menu-link"
              :class="{ 'is-active': active }"
              @click="
                () => {
                  close()
                  signOut(true)
                }
              "
            >
              {{ t('logout') }}
            </a>
          </MenuItem>
        </MenuItems>
      </BaseTransition>
    </Menu>
  </div>
</template>

<style scoped>
.user-icon {
  @apply text-32 text-gray-500;
}

.menu {
  @apply relative flex-shrink-0;
}

.menu-button {
  @apply flex rounded-full bg-app-surface text-sm focus:ring-2 focus:ring-app-primary/30 focus:ring-offset-2 focus:outline-none;
}

.menu-items {
  @apply absolute right-0 mt-2 w-48 origin-top-right rounded-lg border border-app-border bg-app-surface py-1 shadow-lg focus:outline-none;

  &.is-top-start {
    @apply right-auto bottom-full left-0 mt-0 mb-2 origin-bottom-left;
  }
}

.menu-link {
  @apply block px-4 py-2 text-sm text-gray-700;

  &.is-active {
    @apply bg-gray-100;
  }
}

.menu-link-favorites {
  @apply xl:hidden;
}
</style>
