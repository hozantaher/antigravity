<script lang="ts" setup>
const { t } = useI18n()

useSeo({ title: () => t('categories'), description: () => t('seo.categoriesDescription') })
</script>

<template>
  <section class="app-section">
    <div class="app-container">
      <h1 class="app-h1">
        {{ t('categories') }}
      </h1>
      <main class="body">
        <CategoriesGrid />
      </main>
    </div>
  </section>
</template>

<style scoped>
.body {
  @apply py-8;
}
</style>
