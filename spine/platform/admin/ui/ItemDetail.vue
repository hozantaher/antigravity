<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import ItemDetailGeneral from './ItemDetailGeneral.vue'
import ItemDetailDescription from './ItemDetailDescription.vue'
import ItemDetailHighlights from './ItemDetailHighlights.vue'
import ItemDetailImages from './ItemDetailImages.vue'
import ItemDetailBids from './ItemDetailBids.vue'
import ItemDetailQuestions from './ItemDetailQuestions.vue'
import { ItemType } from '~/models'

const props = defineProps<{
  itemId?: string
}>()

const toast = useToast()

const {
  isUploading,
  view,
  item,
  fieldCategory,
  fieldType,
  fieldStartDate,
  fieldEndDate,
  fieldMinBid,
  fieldMinPrice,
  fieldHidden,
  fieldSold,
  fieldTitle,
  fieldPrice,
  fieldTax,
  fieldEmail,
  fieldPhone,
  fetchItem,
  saveItem,
  dispose,
} = useAdminItem()

await fetchItem(props.itemId)

const save = async () => {
  const fields = [
    fieldCategory,
    fieldType,
    fieldHidden,
    fieldSold,
    fieldTitle,
    fieldPrice,
    fieldTax,
    fieldEmail,
    fieldPhone,
  ]
  const auctionFields = [fieldStartDate, fieldEndDate, fieldMinBid, fieldMinPrice]
  if (item.value!.type === ItemType.auction) {
    for (const f of auctionFields) fields.push(f)
  }
  if (!isFormValid(fields)) {
    toast.warning('Form is not valid')
    return
  }
  await saveItem()
}

const changeView = (newView: EditView) => {
  view.value = newView
}

onBeforeUnmount(dispose)
</script>

<template>
  <main class="layout app-section app-container">
    <!-- Primary column -->
    <section aria-labelledby="primary-heading" class="primary">
      <main v-if="item">
        <div class="header">
          <h1 class="app-h1 title">
            <NuxtLinkLocale to="/admin/items">
              <Icon name="heroicons-solid:arrow-left" class="app-icon-btn back-icon" />
            </NuxtLinkLocale>
            {{ item.title ? item.title : 'New item' }}
          </h1>
          <div class="header-actions">
            <NuxtLinkLocale v-if="item.id" :to="itemPath(item)" target="_blank">
              <button type="button" class="app-btn-alt open-btn">
                <Icon name="heroicons-solid:eye" class="open-icon" />
                Open
              </button>
            </NuxtLinkLocale>
            <button type="button" class="app-btn-admin save-btn" @click="save">Save changes</button>
          </div>
        </div>
        <div class="tabs">
          <div class="tab-list">
            <button
              :class="{ 'is-active': view === EditView.general }"
              type="button"
              class="tab"
              @click="changeView(EditView.general)"
            >
              General
            </button>
            <button
              :class="{ 'is-active': view === EditView.description }"
              type="button"
              class="tab"
              @click="changeView(EditView.description)"
            >
              Description
            </button>
            <button
              :class="{ 'is-active': view === EditView.highlights }"
              type="button"
              class="tab"
              @click="changeView(EditView.highlights)"
            >
              Highlights
            </button>
            <button
              v-if="(item.id && item.type === ItemType.auction) || item.bids.length"
              :class="{ 'is-active': view === EditView.bids }"
              type="button"
              class="tab"
              @click="changeView(EditView.bids)"
            >
              {{ item.type === ItemType.auction ? 'Auction' : 'Bids' }}
            </button>
            <button
              v-if="item.id"
              :class="{ 'is-active': view === EditView.questions }"
              type="button"
              class="tab"
              @click="changeView(EditView.questions)"
            >
              Questions
            </button>
          </div>
        </div>
        <div class="views">
          <ItemDetailGeneral v-show="view === EditView.general" />
          <ItemDetailDescription v-show="view === EditView.description" />
          <ItemDetailHighlights v-show="view === EditView.highlights" />
          <ItemDetailBids v-show="view === EditView.bids" />
          <ItemDetailQuestions v-show="view === EditView.questions" />
        </div>
        <div class="mobile-images">
          <ItemDetailImages />
        </div>
      </main>
    </section>
  </main>

  <!-- Secondary column (hidden on smaller screens) -->
  <aside class="secondary">
    <ItemDetailImages />
    <div v-if="isUploading" class="uploading">
      <div>Uploading...</div>
      <Icon name="mdi:loading" class="uploading-icon" />
    </div>
  </aside>
</template>

<style scoped>
.layout {
  @apply flex-1 overflow-y-auto;
}

.primary {
  @apply flex h-full min-w-0 flex-1 flex-col lg:order-last;
}

.header {
  @apply flex flex-col items-center justify-between gap-4 xl:flex-row;
}

.title {
  @apply mb-4 flex items-center;
}

.back-icon {
  @apply mr-4 h-6 w-6 lg:-ml-10 lg:mr-0;
}

.header-actions {
  @apply flex flex-row justify-center gap-4;
}

.open-btn {
  @apply flex w-full items-center gap-2 md:w-auto;
}

.open-icon {
  @apply h-6 w-6;
}

.save-btn {
  @apply w-full whitespace-nowrap md:w-auto;
}

.tabs {
  @apply mt-6 flex flex-col items-center gap-6;
}

.tab-list {
  @apply flex border-b border-app-border;
}

.tab {
  @apply -mb-px inline-flex cursor-pointer items-center border-b-2 border-transparent px-4 py-2 text-sm font-medium text-app-text-muted hover:text-app-text focus:outline-none;

  &.is-active {
    @apply border-app-primary text-app-text-strong;
  }
}

.views {
  @apply my-8;
}

.mobile-images {
  @apply block border-t border-app-border bg-app-surface px-3 pt-4 md:px-2 md:pt-2 lg:px-8 lg:pt-8 xl:hidden;
  @apply !-mx-3 md:!-mx-6 lg:!-mx-14;
}

.secondary {
  @apply relative hidden w-144 overflow-y-auto border-l border-app-border bg-app-surface xl:block;
}

.uploading {
  @apply absolute inset-0 flex h-full w-full flex-col items-center justify-center gap-2 bg-app-surface-muted text-app-text;
}

.uploading-icon {
  @apply h-12 w-12 animate-spin;
}
</style>
