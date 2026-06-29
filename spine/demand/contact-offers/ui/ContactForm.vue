<script lang="ts" setup>
import { useToast } from 'vue-toastification'

const { t } = useI18n()
const { emailValidator } = useValidators()
const toast = useToast()
const localePath = useLocalePath()

const loading = ref(false)

const msg = ref<Record<string, any>>({
  name: undefined,
  email: undefined,
  phone: undefined,
  location: undefined,
  vehicle: undefined,
  message: undefined,
})

const fieldName = ref()
const fieldEmail = ref()
const fieldPhone = ref()
const fieldLocation = ref()
const fieldVehicle = ref()
const fieldMessage = ref()

const send = async () => {
  if (!isFormValid([fieldName, fieldEmail, fieldPhone, fieldLocation, fieldVehicle, fieldMessage])) return

  loading.value = true
  try {
    await $fetch('/api/contact', { method: 'POST', body: msg.value })
  } catch {
    toast.error(t('toastError'))
    return
  } finally {
    loading.value = false
  }
  await navigateTo(localePath('/form-sent'))
}
</script>

<template>
  <div class="root">
    <div class="card-grid">
      <!-- Contact information -->
      <div class="info-panel">
        <div class="decor decor-mobile" aria-hidden="true">
          <svg
            class="decor-svg"
            width="343"
            height="388"
            viewBox="0 0 343 388"
            fill="none"
            preserveAspectRatio="xMidYMid slice"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M-99 461.107L608.107-246l707.103 707.107-707.103 707.103L-99 461.107z"
              fill="url(#linear1)"
              fill-opacity=".1"
            />
            <defs>
              <linearGradient
                id="linear1"
                x1="254.553"
                y1="107.554"
                x2="961.66"
                y2="814.66"
                gradientUnits="userSpaceOnUse"
              >
                <stop stop-color="#fff" />
                <stop offset="1" stop-color="#fff" stop-opacity="0" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div class="decor decor-tablet" aria-hidden="true">
          <svg
            class="decor-svg"
            width="359"
            height="339"
            viewBox="0 0 359 339"
            fill="none"
            preserveAspectRatio="xMidYMid slice"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M-161 382.107L546.107-325l707.103 707.107-707.103 707.103L-161 382.107z"
              fill="url(#linear2)"
              fill-opacity=".2"
            />
            <defs>
              <linearGradient
                id="linear2"
                x1="192.553"
                y1="28.553"
                x2="899.66"
                y2="735.66"
                gradientUnits="userSpaceOnUse"
              >
                <stop stop-color="#fff" />
                <stop offset="1" stop-color="#fff" stop-opacity="0" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div class="decor decor-desktop" aria-hidden="true">
          <svg
            class="decor-svg"
            width="160"
            height="678"
            viewBox="0 0 160 678"
            fill="none"
            preserveAspectRatio="xMidYMid slice"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M-161 679.107L546.107-28l707.103 707.107-707.103 707.103L-161 679.107z"
              fill="url(#linear3)"
              fill-opacity=".3"
            />
            <defs>
              <linearGradient
                id="linear3"
                x1="192.553"
                y1="325.553"
                x2="899.66"
                y2="1032.66"
                gradientUnits="userSpaceOnUse"
              >
                <stop stop-color="#fff" />
                <stop offset="1" stop-color="#fff" stop-opacity="0" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <h3 class="info-title">{{ t('formTitle') }}?</h3>
        <p class="info-desc">
          {{ t('formDescription') }}
        </p>
        <dl class="contact-list">
          <dd class="contact-item">
            <Icon name="heroicons-outline:phone" class="contact-icon" aria-hidden="true" />
            <a href="tel:+420212246451" class="contact-link">+420 212 246 451</a>
          </dd>
          <dd class="contact-item">
            <Icon name="heroicons-outline:mail" class="contact-icon" aria-hidden="true" />
            <a :href="`mailto:${COMPANY.email}`" class="contact-link">{{ COMPANY.email }}</a>
          </dd>
        </dl>
        <ul role="list" class="social-list">
          <li>
            <a class="social-link" target="_blank" href="https://www.facebook.com/MyAuction24">
              <Icon name="cib:facebook" class="social-icon" />
            </a>
          </li>
          <li>
            <a class="social-link" target="_blank" href="https://twitter.com/Auction_24">
              <Icon name="cib:twitter" class="social-icon" />
            </a>
          </li>
          <li>
            <a
              class="social-link"
              target="_blank"
              href="https://www.youtube.com/channel/UCk9aip68zkjXhiy45WiD1bg/videos"
            >
              <Icon name="cib:youtube" class="social-icon" />
            </a>
          </li>
        </ul>
      </div>

      <!-- Contact form -->
      <div class="form-panel">
        <h3 class="form-title">
          {{ t('formSubmit') }}
        </h3>
        <form action="#" method="POST" class="form-grid">
          <BaseInput
            ref="fieldName"
            v-model:value="msg.name"
            name="name"
            type="text"
            :label="t('namePlaceholder')"
            :placeholder="t('namePlaceholder')"
            required
          />
          <BaseInput
            ref="fieldEmail"
            v-model:value="msg.email"
            name="email"
            type="email"
            :label="t('emailPlaceholder')"
            :placeholder="t('emailPlaceholder')"
            :validators="[emailValidator()]"
            required
          />
          <BaseInput
            ref="fieldPhone"
            v-model:value="msg.phone"
            name="phone"
            type="phone"
            :label="t('phonePlaceholder')"
            :placeholder="t('phonePlaceholder')"
          />
          <BaseInput
            ref="fieldLocation"
            v-model:value="msg.location"
            name="location"
            type="text"
            :label="t('vehicleLocation')"
            :placeholder="t('vehicleLocation')"
            required
          />
          <BaseInput
            ref="fieldVehicle"
            v-model:value="msg.vehicle"
            name="vehicle"
            type="text"
            :label="t('whatToSell')"
            :placeholder="t('whatToSell')"
            class="field-wide"
            required
          />
          <div class="field-wide">
            <div class="message-head">
              <label for="message" class="message-label">{{ t('itemDescription') }}</label>
            </div>
            <div class="message-body">
              <BaseTextarea
                ref="fieldMessage"
                v-model:value="msg.message"
                name="message"
                :placeholder="t('itemDescription')"
              />
            </div>
          </div>
          <span class="field-half" />
          <div class="field-half">
            <button :disabled="loading" type="button" class="app-btn" @click="send">
              {{ t('formSubmit') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.root {
  @apply relative overflow-hidden rounded-lg border border-app-border bg-app-surface;
}

.card-grid {
  @apply grid grid-cols-1 lg:grid-cols-3;
}

.info-panel {
  @apply relative overflow-hidden bg-app-primary py-10 px-6 text-white sm:px-10 xl:p-12;
}

.decor {
  @apply pointer-events-none;
}

.decor-mobile {
  @apply absolute inset-0 sm:hidden;
}

.decor-tablet {
  @apply hidden absolute top-0 right-0 bottom-0 w-1/2 sm:block lg:hidden;
}

.decor-desktop {
  @apply hidden absolute top-0 right-0 bottom-0 w-1/2 lg:block;
}

.decor-svg {
  @apply absolute inset-0 w-full h-full;
}

.info-title {
  @apply text-lg font-medium text-white;
}

.info-desc {
  @apply mt-6 max-w-3xl text-base text-white/90;
}

.contact-list {
  @apply mt-8 space-y-6;
}

.contact-item {
  @apply flex text-base text-white/90;
}

.contact-icon {
  @apply h-6 w-6 flex-shrink-0 text-white/70;
}

.contact-link {
  @apply ml-3;
}

.social-list {
  @apply mt-8 flex space-x-12;
}

.social-link {
  @apply text-white/80 hover:text-white;
}

.social-icon {
  @apply h-6 w-6;
}

.form-panel {
  @apply py-10 px-6 sm:px-10 lg:col-span-2 xl:p-12;
}

.form-title {
  @apply text-lg font-medium text-app-text-strong;
}

.form-grid {
  @apply mt-6 grid grid-cols-1 gap-y-6 sm:grid-cols-2 sm:gap-x-8;
}

.field-wide {
  @apply sm:col-span-2;
}

.message-head {
  @apply flex justify-between;
}

.message-label {
  @apply block text-sm font-medium text-app-text-strong;
}

.message-body {
  @apply mt-1;
}

.field-half {
  @apply sm:col-span-1;
}
</style>
