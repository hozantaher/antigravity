<script setup lang="ts">
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/vue'

import { UserRole } from '~/models'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const props = defineProps<{ userId: string }>()
const router = useRouter()

const {
  user,
  invoices,
  invoicesTotal,
  invoicesPage,
  invoicesPageSize,
  fetchUser,
  deleteUser,
  resetPassword,
  setAdmin,
  dispose,
} = useUserDetail()

await fetchUser(props.userId)

onUnmounted(dispose)

const remove = async () => {
  const id = user.value?.id
  if (!id) return
  await deleteUser(id)
  router.push('/admin/users')
}

const isAdmin = computed(() => !!user.value?.roles.includes(UserRole.admin))
const toggleAdmin = () => setAdmin(!isAdmin.value)
</script>

<template>
  <div v-if="user">
    <div class="head">
      <div class="head-row">
        <h2 id="slide-over-heading" class="head-title">User ID: {{ parseUserIdentifier(user.id) }}</h2>
        <div class="head-actions">
          <button type="button" class="close-btn" @click="router.back()">
            <Icon name="heroicons-solid:x" class="close-icon" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
    <!-- Main -->
    <div>
      <div class="main">
        <div>
          <div class="profile">
            <div class="profile-body">
              <div>
                <div class="name-row">
                  <h3 class="name">
                    {{ user.fullName }}
                  </h3>
                  <span v-if="user.roles.includes(UserRole.admin)" class="role role-admin">ADMIN</span>
                  <template v-else>
                    <span
                      v-for="role in user.roles.filter(role => role !== UserRole.admin)"
                      :key="role"
                      :class="{ 'is-user': (role as string) === 'user' }"
                      class="role"
                      >{{ role.toUpperCase() }}</span
                    >
                  </template>
                </div>
                <div class="country">
                  {{ user.address?.country?.name }}
                  <Icon
                    v-if="user.address?.country"
                    :name="`flag:${user.address?.country.code2}-4x3`"
                    class="country-flag"
                  />
                </div>
              </div>
              <div class="contact-actions">
                <a :href="`tel:${user.phone}`" target="_blank" class="app-btn-admin call-btn"> Call </a>
                <a :href="`mailto:${user.email}`" target="_blank" class="app-btn-alt email-btn"> E-mail </a>
                <div class="menu-wrap">
                  <Menu as="div" class="menu">
                    <div>
                      <MenuButton class="menu-button">
                        <Icon name="heroicons-outline:dots-vertical" class="menu-button-icon" aria-hidden="true" />
                      </MenuButton>
                    </div>

                    <BaseTransition :unmount="false">
                      <MenuItems class="menu-items">
                        <div class="menu-items-inner">
                          <MenuItem v-slot="{ active }" @click="toggleAdmin()">
                            <div>
                              <a class="menu-link" href="#" :class="{ 'is-active': active }">
                                {{ isAdmin ? 'Revoke admin' : 'Grant admin' }}
                              </a>
                            </div>
                          </MenuItem>
                          <MenuItem v-slot="{ active }" @click="resetPassword()">
                            <div>
                              <a class="menu-link" href="#" :class="{ 'is-active': active }"> Reset password </a>
                            </div>
                          </MenuItem>
                          <MenuItem v-slot="{ active }">
                            <div>
                              <BaseConfirmation @on-confirm="remove()">
                                <a href="#" class="menu-link menu-link-danger" :class="{ 'is-active': active }"
                                  >Delete account</a
                                >
                              </BaseConfirmation>
                            </div>
                          </MenuItem>
                        </div>
                      </MenuItems>
                    </BaseTransition>
                  </Menu>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="details">
        <div class="details-border">
          <dl class="details-list">
            <div class="detail-row">
              <dt class="label">Email</dt>
              <dd class="value">
                <span class="value-text">{{ user.email }}</span>
              </dd>
            </div>
            <div v-if="user.phone" class="detail-row">
              <dt class="label">Phone</dt>
              <dd class="value">
                <span class="value-text">{{ user.phone }}</span>
              </dd>
            </div>
            <div v-if="user.address" class="detail-row">
              <dt class="label">Location</dt>
              <dd class="value">
                <span class="value-text">
                  {{ user.address.address }}
                  <div>{{ user.address.city }} {{ user.address.zip }}</div>
                  <div>{{ user.address.country?.name }}</div>
                </span>
              </dd>
            </div>
            <div v-if="user.depositBalance" class="detail-row">
              <dt class="label">Deposit</dt>
              <dd class="value">
                <span class="value-text">
                  {{ formatPrice(user.depositBalance) }}
                </span>
              </dd>
            </div>
            <div v-if="user.companyName || user.companyIdNumber || user.companyVatNumber" class="detail-row">
              <dt class="label">Company</dt>
              <dd class="value">
                <span class="value-text">
                  {{ user.companyName }}
                  <div v-if="user.companyIdNumber">
                    <span class="company-key">CIN:</span>
                    {{ user.companyIdNumber }}
                  </div>
                  <div v-if="user.companyVatNumber">
                    <span class="company-key">VAT:</span>
                    {{ user.companyVatNumber }}
                  </div>
                </span>
              </dd>
            </div>
            <div v-if="user.bankAccount" class="detail-row">
              <dt class="label">Bank account</dt>
              <dd class="value">
                <span class="value-text">{{ user.bankAccount }}</span>
              </dd>
            </div>
            <div class="detail-row">
              <dt class="label">Newsletter</dt>
              <dd class="value value-start">
                <span class="value-text">
                  <span v-if="user.newsletter" class="subscribed">Subscribed</span>
                  <Icon v-else name="heroicons-solid:x" class="not-subscribed-icon" />
                </span>
              </dd>
            </div>
            <div class="detail-row">
              <Invoices
                v-model:page="invoicesPage"
                :invoices="invoices"
                :total="invoicesTotal"
                :page-size="invoicesPageSize"
                class="invoices"
                dark
              />
            </div>
          </dl>
        </div>
      </div>
    </div>
  </div>
  <Loading v-else />
</template>

<style scoped>
.head {
  @apply px-4 sm:px-6;
}

.head-row {
  @apply flex items-start justify-between;
}

.head-title {
  @apply flex items-center gap-2 text-lg font-medium text-app-text-strong;
}

.head-actions {
  @apply ml-3 flex h-7 items-center;
}

.close-btn {
  @apply cursor-pointer rounded-lg bg-app-surface text-app-text-muted;

  &:hover {
    @apply text-app-text;
  }
}

.close-icon {
  @apply h-6 w-6;
}

.main {
  @apply pb-1;
}

.profile {
  @apply mt-6 px-4 sm:mt-4 sm:flex sm:items-end sm:px-6;
}

.profile-body {
  @apply sm:flex-1;
}

.name-row {
  @apply flex items-center;
}

.name {
  @apply text-lg font-bold text-app-text-strong sm:text-2xl;
}

.role {
  @apply ml-2 inline-flex items-center rounded-full bg-app-surface-muted px-2 py-0.5 text-xs font-medium text-app-text-muted;

  &.is-user {
    @apply bg-app-green/10 text-app-green;
  }
}

.role-admin {
  @apply bg-app-red/10 text-app-red;
}

.country {
  @apply flex items-center gap-2;
}

.country-flag {
  @apply mr-1 inline-block align-middle text-18;
}

.contact-actions {
  @apply mt-5 flex flex-wrap space-y-3 sm:space-y-0 sm:space-x-3;
}

.call-btn {
  @apply w-full flex-shrink-0 sm:flex-1;
}

.email-btn {
  @apply w-full flex-1;
}

.menu-wrap {
  @apply ml-3 inline-flex sm:ml-0;
}

.menu {
  @apply relative inline-block text-left;
}

.menu-button {
  @apply inline-flex cursor-pointer items-center rounded-lg border border-app-border-strong bg-app-surface p-2 text-sm font-medium text-app-text-muted;

  &:hover {
    @apply bg-app-surface-muted;
  }
}

.menu-button-icon {
  @apply h-5 w-5;
}

.menu-items {
  @apply absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-lg border border-app-border bg-app-surface shadow-lg focus:outline-none;
}

.menu-items-inner {
  @apply py-1;
}

.menu-link {
  @apply block cursor-pointer px-4 py-2 text-sm text-app-text;

  &.is-active {
    @apply bg-app-surface-muted text-app-text-strong;
  }
}

.menu-link-danger {
  @apply text-app-red;
}

.details {
  @apply px-4 pb-5;
}

.details-border {
  @apply mt-5 border-t border-app-border;
}

.details-list {
  @apply divide-y divide-app-border;
}

.detail-row {
  @apply py-4 sm:py-5;
}

.label {
  @apply text-sm font-medium text-app-text-muted;
}

.value {
  @apply mt-1 flex text-sm text-app-text-strong;

  &.value-start {
    @apply items-start;
  }
}

.value-text {
  @apply flex-grow;
}

.company-key {
  @apply mr-1 text-app-text-muted;
}

.subscribed {
  @apply font-medium text-app-green;
}

.not-subscribed-icon {
  @apply h-6 w-6 text-app-red;
}

.invoices {
  @apply mt-1;
}
</style>
