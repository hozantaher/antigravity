<script lang="ts" setup>
import ItemDetailVehicle from './ItemDetailVehicle.vue'
import { ItemType } from '~/models'
import type { OptionItem } from '~/models'

const {
  startDateChange,
  endDateChange,
  getLocalDateString,
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
  item,
  selectedCategory,
} = useAdminItem()

const { emailValidator, phoneValidator } = useValidators()
const { categories } = useCategories()
const { countries } = useCountries()

const { categoryLabel } = useAdminCategoryLabel()
const categoryOptions = computed(() => categories.value.map<OptionItem>(c => ({ label: categoryLabel(c), value: c })))
const typeOptions = computed(() =>
  [ItemType.ad, ItemType.auction].map<OptionItem>(i => ({ label: i === ItemType.ad ? 'Ad' : 'Auction', value: i })),
)
const boolOptions = (yes: string, no: string): OptionItem[] => [
  { label: yes, value: true },
  { label: no, value: false },
]
const hiddenOptions = boolOptions('Hidden', 'Visible')
const soldOptions = boolOptions('Sold', 'Not Sold')
const taxOptions = boolOptions('Tax Included', 'Without tax')
const countryOptions = computed(() => countries.value.map<OptionItem>(c => ({ label: c.name, value: c.code2 })))
</script>

<template>
  <form class="form">
    <div v-if="item" class="sections">
      <div class="section">
        <div>
          <h3 class="heading">General information</h3>
          <p class="subheading">Use form below to modify general information about vehicle.</p>
        </div>
        <div class="fields">
          <div class="field-row">
            <label class="label">Category <span class="required">*</span></label>
            <div class="field">
              <BaseSelect ref="fieldCategory" v-model:value="selectedCategory" :options="categoryOptions" required />
            </div>
          </div>

          <div class="field-row">
            <label class="label">Internal ID</label>
            <div class="field">
              <BaseInput v-model:value="item.internalId" type="text" placeholder="Internal ID" />
            </div>
          </div>

          <div class="field-row">
            <label class="label">Type <span class="required">*</span></label>
            <div class="field">
              <BaseSelect ref="fieldType" v-model:value="item.type" :options="typeOptions" required />
            </div>
          </div>

          <div v-if="item.type === ItemType.auction" class="field-row auction-row">
            <label class="label">Start date <span class="required">*</span></label>
            <div class="field">
              <BaseInput
                ref="fieldStartDate"
                :value="getLocalDateString(item.startDate)"
                type="datetime-local"
                @change="startDateChange($event.target.value)"
              />
            </div>
            <label class="label">End date <span class="required">*</span></label>
            <div class="field">
              <BaseInput
                ref="fieldEndDate"
                :value="getLocalDateString(item.endDate)"
                type="datetime-local"
                @change="endDateChange($event.target.value)"
              />
            </div>
            <label class="label">Minimal bid <span class="required">*</span></label>
            <div class="field">
              <BaseInput ref="fieldMinBid" v-model:value="item.minBid!.amount" type="number" required>
                <template #suffix> EUR </template>
              </BaseInput>
            </div>
            <label class="label">Minimal price <span class="required">*</span></label>

            <div class="field price-min-field">
              <BaseInput ref="fieldMinPrice" v-model:value="item.minimalPrice!.amount" type="number" required>
                <template #suffix> EUR </template>
              </BaseInput>
            </div>
          </div>
        </div>
      </div>

      <div class="field-row">
        <label class="label">Visibility <span class="required">*</span></label>
        <div class="field">
          <BaseSelect ref="fieldHidden" v-model:value="item.hidden" :options="hiddenOptions" required />
        </div>
      </div>

      <div class="field-row">
        <label class="label">Sold <span class="required">*</span></label>
        <div class="field">
          <BaseSelect ref="fieldSold" v-model:value="item.sold" :options="soldOptions" required />
        </div>
      </div>

      <div class="field-row">
        <label class="label">Title <span class="required">*</span></label>
        <div class="field">
          <BaseInput ref="fieldTitle" v-model:value="item.title" type="text" placeholder="Item title" required />
        </div>
      </div>

      <div class="field-row">
        <label class="label">Price <span class="required">*</span></label>
        <div class="price-field">
          <BaseInput
            ref="fieldPrice"
            v-model:value="item.priceFrom!.amount"
            type="number"
            placeholder="Amount"
            required
          >
            <template #suffix> EUR </template>
          </BaseInput>
        </div>
        <div class="tax-field">
          <BaseSelect ref="fieldTax" v-model:value="item.taxIncluded" :options="taxOptions" required />
        </div>
      </div>

      <div class="field-row">
        <label class="label">Location</label>
        <div class="field location-field">
          <BaseSelect v-model:value="item.countryCode" :options="countryOptions" placeholder="Country">
            <template #hint> Flag on item detail </template>
          </BaseSelect>

          <BaseGeoInput v-model:value="item.gps" />
          <StaticMap v-if="item.gps" class="static-map" :gps="item.gps" />
        </div>
      </div>
      <div class="field-row">
        <label class="label">Email</label>
        <div class="field">
          <BaseInput
            ref="fieldEmail"
            v-model:value="item.email"
            type="email"
            placeholder="Contact email"
            :validators="[emailValidator()]"
          />
        </div>
      </div>
      <div class="field-row">
        <label class="label">Phone</label>
        <div class="field">
          <BaseInput
            ref="fieldPhone"
            v-model:value="item.phone"
            type="tel"
            placeholder="Contact phone"
            :validators="[phoneValidator()]"
          />
        </div>
      </div>
      <div class="field-row">
        <label class="label">Youtube</label>
        <div class="field">
          <BaseInput v-model:value="item.youtubeVideoId" type="text" placeholder="Youtube ID only" />
        </div>
      </div>

      <ItemDetailVehicle />
    </div>
  </form>
</template>

<style scoped>
.form {
  @apply space-y-8 pb-30;
}

.sections {
  @apply space-y-8 sm:space-y-5;
}

.section {
  @apply space-y-6 sm:space-y-5;
}

.heading {
  @apply text-lg font-medium text-app-text-strong;
}

.subheading {
  @apply mt-1 max-w-2xl text-sm text-app-text-muted;
}

.fields {
  @apply space-y-6 sm:space-y-5;
}

.field-row {
  @apply sm:grid sm:grid-cols-3 sm:items-start sm:gap-4;
}

.auction-row {
  @apply space-y-4 -m-2 bg-app-surface-muted p-2 sm:items-center sm:pt-0 md:-m-4 md:p-4;
}

.label {
  @apply block text-sm font-medium text-app-text sm:mt-px sm:pt-2;
}

.required {
  @apply ml-1 text-lg text-app-red;
}

.field {
  @apply mt-1 sm:col-span-2 sm:mt-0;
}

.price-min-field {
  @apply pb-2 md:pb-4;
}

.price-field {
  @apply mt-1 sm:col-span-1 sm:mt-0;
}

.tax-field {
  @apply mt-4 sm:col-span-1 sm:mt-0;
}

.location-field {
  @apply flex flex-col gap-4;
}

.static-map {
  @apply h-80 w-full md:h-125;
}
</style>
