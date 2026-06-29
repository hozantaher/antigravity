<script lang="ts" setup>
import { Skeletor } from 'vue-skeletor'
</script>

<template>
  <section class="app-section">
    <div class="app-container-center">
      <div>
        <h1 class="app-h1 title-desktop">
          <Skeletor class="title-skeleton-desktop" width="40%" />
        </h1>
        <h1 class="app-h1 title-mobile">
          <Skeletor width="80%" />
        </h1>
        <h2 class="subtitle subtitle-desktop">
          <Skeletor width="30%" />
        </h2>
        <h2 class="subtitle subtitle-mobile">
          <Skeletor width="60%" />
        </h2>
      </div>

      <main class="body">
        <div class="layout">
          <div class="media media-desktop">
            <Skeletor class="skeleton-rounded" height="600px" />
          </div>
          <div class="media media-mobile">
            <Skeletor class="skeleton-rounded" height="270px" />
          </div>
          <div class="sidebar">
            <div class="sidebar-full">
              <Skeletor class="skeleton-rounded" height="180px" />
            </div>
            <div class="sidebar-secondary">
              <Skeletor class="secondary-skeleton" height="480px" />
            </div>
          </div>
        </div>
      </main>
    </div>
  </section>
</template>

<style scoped>
.title-desktop {
  @apply hidden md:block;
}

.title-skeleton-desktop {
  @apply hidden md:block;
}

.title-mobile {
  @apply md:hidden;
}

.subtitle {
  @apply mt-3;
}

.subtitle-desktop {
  @apply hidden md:block;
}

.subtitle-mobile {
  @apply md:hidden;
}

.body {
  @apply py-8;
}

.layout {
  @apply flex flex-col justify-between gap-4 md:flex-row lg:gap-8 xl:gap-16;
}

.media {
  @apply w-full md:w-3/5;
}

.media-desktop {
  @apply hidden md:block;
}

.media-mobile {
  @apply md:hidden;
}

.sidebar {
  @apply w-full md:w-2/5;
}

.sidebar-full {
  @apply w-full;
}

.sidebar-secondary {
  @apply hidden w-full md:block;
}

.skeleton-rounded {
  @apply rounded-lg;
}

.secondary-skeleton {
  @apply mt-8 rounded-lg;
}
</style>
