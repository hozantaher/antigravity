<script lang="ts" setup>
const { t } = useI18n()

useSeo({ title: () => t('contact'), description: () => t('seo.contactDescription') })
</script>

<template>
  <section class="app-section">
    <div class="app-container-center page-top">
      <div class="sections">
        <section class="info-section" aria-labelledby="contact-heading">
          <h2 id="contact-heading" class="section-title">
            {{ t('contact') }}
          </h2>
          <div class="info-cols">
            <div>
              <h3 class="detail-title">
                {{ t('companyInfo') }}
              </h3>
              <dl class="detail-list">
                <dt>
                  <b>{{ COMPANY.name }}</b>
                </dt>
                <dt class="detail-item">{{ t('ICO') }}: {{ COMPANY.ico }}</dt>
                <dt class="detail-item">{{ t('DIC') }}: {{ COMPANY.dic }}</dt>
              </dl>
            </div>
            <div>
              <h3 class="detail-title">
                {{ t('contacts') }}
              </h3>
              <dl class="detail-list">
                <dt>{{ t('phone') }}: +420 212 246 452</dt>
                <dt class="detail-item">{{ t('mobile') }}: +420 608 708 258</dt>
                <dt class="detail-item">{{ t('email') }}: {{ COMPANY.email }}</dt>
              </dl>
            </div>
          </div>
        </section>
        <section class="location-section" aria-labelledby="location-heading">
          <div>
            <h2 class="section-title">
              {{ t('address') }}
            </h2>
            <dl class="detail-list">
              <dt>{{ COMPANY.street }}</dt>
              <dt class="detail-item">{{ COMPANY.city }}</dt>
              <dt class="detail-item">{{ COMPANY.country }}</dt>
            </dl>
          </div>
          <div class="map-wrap">
            <iframe
              src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2561.9225696934404!2d14.437017616479913!3d50.05028177942213!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x470b94759b1f6d5b%3A0x588df01abda2d398!2sNa%20Str%C5%BEi%201702%2F65%2C%20140%2000%20Praha%204-Nusle!5e0!3m2!1sen!2scz!4v1661934050669!5m2!1sen!2scz"
              width="800"
              height="450"
              class="map-frame"
              allowfullscreen
              loading="lazy"
              referrerpolicy="no-referrer-when-downgrade"
            />
          </div>
        </section>
      </div>
    </div>
  </section>
  <section class="form-section">
    <div class="app-container-center">
      <ContactForm />
    </div>
  </section>
</template>

<style scoped>
.page-top {
  @apply md:pt-16;
}

.sections {
  @apply divide-y divide-app-border;
}

.info-section {
  @apply lg:grid lg:grid-cols-3 lg:gap-8;
}

.section-title {
  @apply text-2xl font-bold text-app-text-strong sm:text-32 sm:tracking-tight;
}

.info-cols {
  @apply mt-8 grid grid-cols-1 gap-12 sm:grid-cols-2 sm:gap-x-8 sm:gap-y-12 lg:col-span-2 lg:mt-0;
}

.detail-title {
  @apply text-lg font-medium text-app-text-strong;
}

.detail-list {
  @apply mt-2 text-base text-app-text-muted;
}

.detail-item {
  @apply mt-1;
}

.location-section {
  @apply mt-16 pt-16 lg:grid lg:grid-cols-3 lg:gap-8;
}

.map-wrap {
  @apply mt-8 w-full overflow-hidden rounded-lg border border-app-border md:w-150 lg:mt-0 xl:w-175;
}

.map-frame {
  @apply block max-w-full border-0;
}

.form-section {
  @apply bg-app-surface py-8 md:py-16;
}
</style>
