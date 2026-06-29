<script setup lang="ts">
import { Dialog, DialogPanel, TransitionChild, TransitionRoot } from '@headlessui/vue'
import { UserRole } from '~/models'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const route = useRoute()
const router = useRouter()

const { users, total, loading, fetchPage, dispose } = useUserList()

const { page, pageSize } = useAdminPagedList({
  fetch: ({ page, pageSize, q }) => fetchPage({ page, pageSize, q }),
  dispose,
})
</script>

<template>
  <div class="app-section page">
    <div class="app-container">
      <div class="header">
        <div class="header-main">
          <h1 class="title">
            Users <span class="count">({{ users === undefined ? '--' : total }})</span>
          </h1>
          <p class="subtitle">
            A list of all the users in system including their name, title, email and role and more.
          </p>
        </div>
      </div>
      <div class="listing">
        <div class="listing-scroll">
          <div class="listing-inner">
            <div class="listing-card" :class="{ 'is-loading': loading && users }">
              <table class="data-table">
                <thead class="listing-head">
                  <tr>
                    <th scope="col" class="th th-first">UserID</th>
                    <th scope="col" class="th">Fullname</th>
                    <th scope="col" class="th">Phone</th>
                    <th scope="col" class="th">Email</th>
                    <th scope="col" class="th th-deposit">Deposit</th>
                    <th scope="col" class="th">Country</th>
                    <th scope="col" class="th">Roles</th>
                    <th scope="col" class="th th-last" />
                  </tr>
                </thead>
                <tbody v-if="users?.length" class="listing-body">
                  <NuxtLink
                    v-for="user in users"
                    :key="user.id"
                    v-slot="{ isActive, href, navigate }"
                    :to="`/admin/users/${user.id}`"
                    custom
                  >
                    <tr class="data-row" :class="{ 'is-active': isActive }" @click="navigate">
                      <td class="td td-first">
                        {{ parseUserIdentifier(user.id) }}
                      </td>
                      <td class="td">
                        {{ user.fullName }}
                      </td>
                      <td class="td">
                        {{ user.phone }}
                      </td>
                      <td class="td td-email">
                        {{ user.email }}
                      </td>
                      <td class="td td-deposit">
                        {{ formatPrice(user.depositBalance) }}
                      </td>
                      <td class="td">
                        <span v-if="user.address?.country">
                          <Icon :name="`flag:${user.address?.country.code2}-4x3`" class="flag" />
                          <span>{{ user.address?.country.name }}</span>
                        </span>
                        <div v-if="user.language" class="language">
                          {{ user.language.name }}
                        </div>
                      </td>
                      <td class="td">
                        <span v-if="user.roles.includes(UserRole.admin)" class="role role-admin">ADMIN</span>
                        <template v-else>
                          <span
                            v-for="role in user.roles.filter(role => role !== UserRole.admin)"
                            :key="role"
                            class="role"
                            :class="{ 'is-user': (role as string) === 'user' }"
                            >{{ role.toUpperCase() }}</span
                          >
                        </template>
                      </td>
                      <td class="td td-action">
                        <a :href="href ?? undefined" class="app-text-btn-admin" @click="navigate"> View </a>
                      </td>
                    </tr>
                  </NuxtLink>
                </tbody>
                <TableBodySkeletor v-if="!users" :rows="5" :cols="8" />
              </table>
            </div>
          </div>
        </div>
        <NoItems v-if="users?.length === 0" class="no-items" />
        <BasePagination v-model:page="page" :total="total" :page-size="pageSize" variant="admin" />
      </div>

      <TransitionRoot as="template" :show="!!route.params.userId">
        <Dialog as="div" class="dialog" @close="router.back()">
          <TransitionChild
            as="template"
            enter="ease-in-out duration-500"
            enter-from="opacity-0"
            enter-to="opacity-100"
            leave="ease-in-out duration-500"
            leave-from="opacity-100"
            leave-to="opacity-0"
          >
            <div class="dialog-backdrop" />
          </TransitionChild>

          <div class="dialog-wrap">
            <div class="dialog-overlay">
              <div class="panel-positioner">
                <TransitionChild
                  as="template"
                  enter="transform transition ease-in-out duration-500 sm:duration-700"
                  enter-from="translate-x-full"
                  enter-to="translate-x-0"
                  leave="transform transition ease-in-out duration-500 sm:duration-700"
                  leave-from="translate-x-0"
                  leave-to="translate-x-full"
                >
                  <DialogPanel class="panel">
                    <div class="panel-body">
                      <NuxtPage :key="route.params.userId?.toString()" />
                    </div>
                  </DialogPanel>
                </TransitionChild>
              </div>
            </div>
          </div>
        </Dialog>
      </TransitionRoot>
    </div>
  </div>
</template>

<style scoped>
.page {
  @apply flex-1;
}

.header {
  @apply sm:flex sm:items-center;
}

.header-main {
  @apply sm:flex-auto;
}

.title {
  @apply text-lg font-semibold text-app-text-strong;
}

.count {
  @apply text-lg text-app-text-muted;
}

.subtitle {
  @apply mt-2 hidden text-app-text md:block;
}

.listing {
  @apply mt-8 flex flex-col;
}

.listing-scroll {
  @apply -mx-3 md:mx-0;
}

.listing-inner {
  @apply inline-block min-w-full px-0.5 py-2 align-middle;
}

.listing-card {
  @apply overflow-hidden border border-app-border bg-app-surface transition-opacity duration-200 md:rounded-lg;

  &.is-loading {
    @apply pointer-events-none opacity-60;
  }
}

.data-table {
  @apply min-w-full divide-y divide-app-border;
}

.listing-head {
  @apply bg-app-surface-muted;
}

.th {
  @apply px-3 py-3.5 text-left text-xs font-medium tracking-wide text-app-text-muted uppercase;
}

.th-first {
  @apply py-3.5 pr-3 pl-4 text-left text-xs font-medium tracking-wide text-app-text-muted uppercase sm:pl-6;
}

.th-deposit {
  @apply px-3 py-3.5 text-right;
}

.th-last {
  @apply relative py-3.5 pr-4 pl-3 sm:pr-6;
}

.listing-body {
  @apply divide-y divide-app-border bg-app-surface;
}

.data-row {
  @apply cursor-pointer;

  &:hover {
    @apply bg-app-surface-muted;
  }

  &.is-active {
    @apply bg-app-surface-muted;
  }
}

.td {
  @apply px-3 py-4 text-sm whitespace-nowrap text-app-text;
}

.td-first {
  @apply py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-app-text-strong sm:pl-6;
}

.td-email {
  @apply text-app-primary;

  &:hover {
    @apply underline;
  }
}

.td-deposit {
  @apply text-right text-app-text tabular-nums;
}

.td-action {
  @apply relative px-3 py-4 text-sm font-medium whitespace-nowrap;
}

.flag {
  @apply mr-1 inline-block align-middle text-18;
}

.language {
  @apply text-xs text-app-text-muted;
}

.role {
  @apply mr-2 inline-flex items-center rounded-full bg-app-surface-muted px-2 py-0.5 text-xs font-medium text-app-text-muted;

  &.is-user {
    @apply bg-app-green/10 text-app-green;
  }
}

.role-admin {
  @apply bg-app-red/10 text-app-red;
}

.no-items {
  @apply mt-16;
}

.dialog {
  @apply relative z-10;
}

.dialog-backdrop {
  @apply fixed inset-0 bg-app-text-strong/40 transition-opacity;
}

.dialog-wrap {
  @apply fixed inset-0 overflow-hidden;
}

.dialog-overlay {
  @apply absolute inset-0 overflow-hidden;
}

.panel-positioner {
  @apply pointer-events-none fixed inset-y-0 right-0 flex max-w-full sm:pl-16;
}

.panel {
  @apply pointer-events-auto w-screen max-w-full sm:max-w-4xl;
}

.panel-body {
  @apply flex h-full flex-col overflow-y-scroll bg-app-surface py-6 shadow-xl;
}
</style>
