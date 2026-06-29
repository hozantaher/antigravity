<script lang="ts" setup>
import type { Item } from '~/models'

const props = defineProps<{ item: Item }>()
const { t } = useI18n()

interface Row {
  label: string
  value: string
}

const rows = computed<Row[]>(() => {
  const it = props.item
  const s = it.specs ?? {}
  const out: Row[] = []
  const push = (label: string, value: string | number | undefined | null) => {
    if (value === undefined || value === null || value === '') return
    out.push({ label, value: String(value) })
  }

  push(t('vehicle.brand'), s.manufacturer)
  push(t('vehicle.model'), s.model)
  push(t('vehicle.year'), s.yearOfManufacture)
  push(
    t('vehicle.firstRegistration'),
    // firstRegistrationDate is a 'YYYY-MM-DD' calendar string — format it as-is (no `new Date`,
    // which parses as UTC and shifts a day / mismatches hydration in negative-offset zones).
    it.firstRegistrationDate ? formatDate(it.firstRegistrationDate) : undefined,
  )
  push(t('vehicle.fuelType'), it.fuelType ? t(`vehicle.fuel.${it.fuelType}`) : undefined)
  push(t('vehicle.transmission'), it.transmission ? t(`vehicle.trans.${it.transmission}`) : undefined)
  push(t('vehicle.bodyType'), it.bodyType ? t(`vehicle.body.${it.bodyType}`) : undefined)
  push(t('vehicle.driveType'), it.driveType ? t(`vehicle.drive.${it.driveType}`) : undefined)
  push(t('vehicle.color'), it.color ? t(`vehicle.colors.${it.color}`) : undefined)

  if (it.enginePowerKw != null) {
    const hp = s.enginePowerHp != null ? ` (${s.enginePowerHp} HP)` : ''
    push(t('vehicle.power'), `${it.enginePowerKw} kW${hp}`)
  } else if (s.enginePowerHp != null) {
    push(t('vehicle.power'), `${s.enginePowerHp} HP`)
  }
  push(t('vehicle.displacement'), it.engineDisplacementCcm != null ? `${it.engineDisplacementCcm} ccm` : undefined)
  push(t('vehicle.gears'), s.numberOfGears)
  push(t('vehicle.emission'), s.emissionStandard)
  push(t('vehicle.co2'), s.co2EmissionGkm != null ? `${s.co2EmissionGkm} g/km` : undefined)
  push(t('vehicle.doors'), s.numberOfDoors)
  push(t('vehicle.seats'), s.numberOfSeats)
  push(t('vehicle.axles'), s.numberOfAxles)
  push(t('vehicle.length'), s.lengthMm != null ? `${s.lengthMm} mm` : undefined)
  push(t('vehicle.width'), s.widthMm != null ? `${s.widthMm} mm` : undefined)
  push(t('vehicle.height'), s.heightMm != null ? `${s.heightMm} mm` : undefined)
  push(t('vehicle.wheelbase'), s.wheelbaseMm != null ? `${s.wheelbaseMm} mm` : undefined)
  push(t('vehicle.weight'), s.weightEmptyKg != null ? `${s.weightEmptyKg} kg` : undefined)
  push(t('vehicle.maxSpeed'), s.maxSpeedKmh != null ? `${s.maxSpeedKmh} km/h` : undefined)
  push(t('vehicle.vin'), it.vin)

  return out
})
</script>

<template>
  <div v-if="rows.length" class="app-panel vehicle-panel">
    <div class="app-panel-heading vehicle-heading">
      <h3>
        {{ t('vehicle.title') }}
      </h3>
    </div>
    <dl>
      <div
        v-for="(row, index) in rows"
        :key="row.label"
        class="vehicle-row"
        :class="{ 'is-alt': index % 2 === 0, 'is-last': index + 1 === rows.length }"
      >
        <dt class="vehicle-term">
          {{ row.label }}
        </dt>
        <dd class="vehicle-def">
          {{ row.value }}
        </dd>
      </div>
    </dl>
  </div>
</template>

<style scoped>
.vehicle-panel {
  @apply mt-8 !px-0;
}

.vehicle-heading {
  @apply px-4;
}

.vehicle-row {
  @apply grid grid-cols-3 bg-app-surface px-4 py-3 sm:gap-4;

  &.is-alt {
    @apply !bg-app-surface-muted;
  }

  &.is-last {
    @apply rounded-b-lg;
  }
}

.vehicle-term {
  @apply text-sm font-medium text-app-text-muted;
}

.vehicle-def {
  @apply mt-1 text-sm text-app-text-strong sm:col-span-2 sm:mt-0;
}
</style>
