<script lang="ts" setup>
const { t } = useI18n()
const { categories } = useCategories()

const catImg = (id: string) => `/category-icons/${id}.svg`
</script>

<template>
  <div>
    <div role="list" class="categories">
      <NuxtLinkLocale v-for="c in categories" :key="c.id" :to="`/category/${c.id}`" class="category">
        <img class="category-img" :src="catImg(c.id)" :alt="c.title" />
        <div class="category-title">
          {{ t(`${c.id}Category`) }}
        </div>
      </NuxtLinkLocale>
    </div>
  </div>
</template>

<style scoped>
.categories {
  @apply grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4;
}

.category {
  @apply col-span-1 flex flex-col rounded-lg border border-app-border bg-app-surface p-4 text-center font-medium uppercase hover:bg-app-surface-muted;
}

.category-img {
  @apply my-5 max-h-10 md:max-h-15;
}

/* Divider on the title's top — NOT divide-y on .category, which @apply flattens
   onto the img as a border-bottom glued to the icon. */
.category-title {
  @apply border-t border-app-border pt-5 font-bold;
}
</style>
