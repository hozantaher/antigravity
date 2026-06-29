<script setup lang="ts">
import type { OptionItem } from '~/models'

// BaseInput — live props
const inputValue = ref<string | number>('')
const inputTypes = ['text', 'email', 'password', 'number']
const inputType = ref('text')
const required = ref(true)
const readOnly = ref(false)
const withPrefix = ref(false)
const withSuffix = ref(true)
const withHint = ref(true)
const inputRef = ref<{ validate: () => void } | null>(null)

// BaseTextarea
const textareaValue = ref('')
const rows = ref(4)

// BaseSelect
const typeOptions: OptionItem[] = [
  { label: 'Auction', value: 'auction' },
  { label: 'Buy now', value: 'ad' },
  { label: 'Sold', value: 'sold' },
  { label: 'Hidden', value: 'hidden' },
]
const selectValue = ref<string>('')
const multiValue = ref<string[]>(['auction', 'ad'])

// BaseCheckbox
const checkboxValue = ref(true)
const newsletter = ref(false)

// BaseRadio
const payOptions: OptionItem[] = [
  { label: 'Card', value: 'card' },
  { label: 'Bank transfer', value: 'bank' },
]
const radioValue = ref('card')
const radioValue2 = ref('bank')

// BaseGeoInput
const geo = ref<{ address: string; lat: number; lng: number }>()

// BaseForm
const formName = ref('')
const formEmail = ref('')
const formSubmits = ref(0)
</script>

<template>
  <PlaygroundSection id="forms" title="Form controls" subtitle="Base* input primitives — toggle props live.">
    <PlaygroundSpecimen
      name="BaseInput"
      tag="Base"
      surface="white"
      :chips="['type', 'value', 'required', 'readOnly', 'prefix', 'suffix', 'hint', 'validators']"
    >
      <BaseInput
        ref="inputRef"
        v-model:value="inputValue"
        :type="inputType"
        :required="required"
        :read-only="readOnly"
        label="Field label"
        placeholder="Type something…"
      >
        <template v-if="withPrefix" #prefix>€</template>
        <template v-if="withSuffix" #suffix>CZK</template>
        <template v-if="withHint" #hint>This hint disappears when an error shows.</template>
      </BaseInput>

      <template #controls>
        <div class="pg-ctl">
          <span class="pg-ctl-label">type</span>
          <div class="pg-seg">
            <button
              v-for="t in inputTypes"
              :key="t"
              type="button"
              class="pg-seg-btn"
              :class="{ 'is-active': inputType === t }"
              @click="inputType = t"
            >
              {{ t }}
            </button>
          </div>
        </div>
        <BaseCheckbox v-model:value="required" label="required" />
        <BaseCheckbox v-model:value="readOnly" label="readOnly" />
        <BaseCheckbox v-model:value="withPrefix" label="prefix" />
        <BaseCheckbox v-model:value="withSuffix" label="suffix" />
        <BaseCheckbox v-model:value="withHint" label="hint" />
        <button type="button" class="app-btn pg-btn" @click="inputRef?.validate()">Validate</button>
      </template>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="BaseTextarea" tag="Base" surface="white" :chips="['value', 'rows', 'required', 'hint']">
      <BaseTextarea v-model:value="textareaValue" :rows="rows" label="Message" placeholder="Write a message…">
        <template #hint>Multiline free text.</template>
      </BaseTextarea>
      <template #controls>
        <div class="pg-ctl">
          <span class="pg-ctl-label">rows: {{ rows }}</span>
          <input v-model.number="rows" type="range" min="2" max="10" class="pg-range" />
        </div>
      </template>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="BaseSelect"
      tag="Base"
      surface="white"
      :chips="['options', 'value', 'multiple', 'searchable', 'placeholder']"
      description="Wraps @vueform/multiselect. Single + searchable, and tags mode."
    >
      <div class="pg-two-col">
        <BaseSelect v-model:value="selectValue" label="Single (searchable)" :options="typeOptions" />
        <BaseSelect v-model:value="multiValue" label="Multiple (tags)" :options="typeOptions" multiple />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="BaseCheckbox" tag="Base" surface="white" :chips="['value', 'label', 'slot']">
      <div class="pg-stack">
        <BaseCheckbox v-model:value="checkboxValue" label="I agree to the terms" />
        <BaseCheckbox v-model:value="newsletter">
          <span class="pg-inline">Subscribe — <a class="app-link" href="#">read more</a></span>
        </BaseCheckbox>
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="BaseRadio"
      tag="Base"
      surface="white"
      :chips="['name', 'options', 'value', 'slot:option']"
    >
      <div class="pg-two-col">
        <BaseRadio v-model:value="radioValue" name="pg-pay-a" :options="payOptions" label="Default" hint="Pick one" />
        <BaseRadio v-model:value="radioValue2" name="pg-pay-b" :options="payOptions" label="Custom option slot">
          <template #option="{ option }">
            <span class="pg-radio-custom">{{ option.label }} →</span>
          </template>
        </BaseRadio>
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="BaseGeoInput"
      tag="Base"
      surface="white"
      :chips="['value:Gps']"
      description="Mock geocoder — emits placeholder coordinates."
    >
      <BaseGeoInput v-model:value="geo" />
      <p class="pg-geo-out">{{ geo ? `${geo.address} · ${geo.lat}, ${geo.lng}` : 'No value emitted yet.' }}</p>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="BaseForm"
      tag="Base"
      surface="white"
      :chips="['slot:default', 'slot:button', 'onSubmit']"
      description="Thin wrapper that delegates the button-slot click to onSubmit."
    >
      <BaseForm @on-submit="formSubmits++">
        <div class="pg-two-col">
          <BaseInput v-model:value="formName" type="text" label="Name" placeholder="Jane Doe" />
          <BaseInput v-model:value="formEmail" type="email" label="E-mail" placeholder="jane@example.com" />
        </div>
        <template #button>
          <button type="submit" class="app-btn pg-btn pg-form-btn">Submit (fired {{ formSubmits }}×)</button>
        </template>
      </BaseForm>
    </PlaygroundSpecimen>
  </PlaygroundSection>
</template>

<style scoped>
.pg-two-col {
  @apply grid gap-4 sm:grid-cols-2;
}

.pg-stack {
  @apply flex flex-col gap-3;
}

.pg-inline {
  @apply text-sm text-gray-700;
}

.pg-ctl {
  @apply flex flex-col gap-1;
}

.pg-ctl-label {
  @apply font-mono text-xs text-gray-400;
}

.pg-seg {
  @apply flex overflow-hidden rounded-lg border border-gray-300;
}

.pg-seg-btn {
  @apply cursor-pointer border-r border-gray-300 bg-white px-2 py-1 text-center text-xs font-medium text-gray-600;
  @apply hover:bg-gray-50 last:border-r-0;

  &.is-active {
    @apply bg-app-red text-white hover:bg-app-red;
  }
}

.pg-range {
  @apply w-40 cursor-pointer;
}

.pg-btn {
  @apply w-auto;
}

.pg-form-btn {
  @apply mt-4;
}

.pg-radio-custom {
  @apply font-medium text-app-primary;
}

.pg-geo-out {
  @apply mt-2 font-mono text-xs text-gray-500;
}
</style>
