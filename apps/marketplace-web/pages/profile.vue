<script lang="ts" setup>
const { t } = useI18n()

useSeo({ title: () => t('accountTitle'), noindex: true })

definePageMeta({ middleware: 'auth' })

const router = useRouter()
const route = useRoute()
const localePath = useLocalePath()

const tabs = computed(() => [
  { name: t('details'), path: '' },
  { name: t('billingTitle'), path: 'billing' },
])

const changeTab = (event: any) => {
  router.push(localePath(event.target.value ? `/profile/${event.target.value}` : '/profile'))
}

const { user } = useUser()
</script>

<template>
  <section class="app-section">
    <div class="app-container">
      <h1 class="app-h1">{{ t('accountTitle') }} ({{ parseUserIdentifier(user?.id) }})</h1>
      <main class="profile-main">
        <div class="profile-inner">
          <div class="profile-tabs">
            <!-- Tabs -->
            <div class="tab-select-wrap">
              <label for="selected-tab" class="tab-select-label">{{ t('selectTab') }}</label>
              <select id="selected-tab" name="selected-tab" class="tab-select" @change="changeTab">
                <option
                  v-for="tab in tabs"
                  :key="tab.name"
                  :value="tab.path"
                  :selected="tab.path ? route.path.includes(tab.path) : route.path === '/profile'"
                >
                  {{ tab.name }}
                </option>
              </select>
            </div>
            <div class="tab-nav-wrap">
              <div class="tab-nav-border">
                <nav class="tab-nav">
                  <NuxtLink
                    v-for="tab in tabs"
                    :key="tab.name"
                    v-slot="{ isExactActive, href, navigate }"
                    :to="tab.path ? `/profile/${tab.path}` : '/profile'"
                    custom
                  >
                    <a
                      :href="href ?? undefined"
                      class="tab-link"
                      :class="{ 'is-active': isExactActive }"
                      @click="navigate"
                    >
                      {{ tab.name }}
                    </a>
                  </NuxtLink>
                </nav>
              </div>
            </div>

            <div>
              <NuxtPage />
            </div>
          </div>
        </div>
      </main>
    </div>
  </section>
</template>

<style scoped>
.profile-main {
  @apply py-8;
}

.profile-inner {
  @apply px-4 sm:px-6 md:px-0;
}

.profile-tabs {
  @apply py-2;
}

.tab-select-wrap {
  @apply lg:hidden;
}

.tab-select-label {
  @apply sr-only;
}

.tab-select {
  @apply mt-1 block w-full rounded-lg border-app-border-strong py-2 pl-3 pr-10 text-base focus:border-app-primary focus:outline-none focus:ring-app-primary sm:text-sm;
}

.tab-nav-wrap {
  @apply hidden lg:block;
}

.tab-nav-border {
  @apply border-b border-app-border;
}

.tab-nav {
  @apply -mb-px flex space-x-8;
}

.tab-link {
  @apply whitespace-nowrap border-b-2 border-transparent px-1 py-4 text-sm font-medium text-app-text-muted hover:border-app-border-strong hover:text-app-text;

  &.is-active {
    @apply border-app-primary text-app-text-strong;
  }
}
</style>
