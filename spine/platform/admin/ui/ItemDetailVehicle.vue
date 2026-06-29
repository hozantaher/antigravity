<script lang="ts" setup>
import { ModalSize, FUEL_TYPES, TRANSMISSIONS, BODY_TYPES, DRIVE_TYPES, VEHICLE_COLORS } from '~/models'
import type { OptionItem, VehicleSpecs, FuelType, Transmission, BodyType, DriveType, VehicleColor } from '~/models'

const { item } = useAdminItem()
const { decoding, canDecode, decode, decodeOffline, source, result, showResult, overwrite, applyResult } =
  useAdminItemVinDecode(item)

const config = useRuntimeConfig()
const vincarioEnabled = computed(() => Boolean(config.public.vincarioEnabled))

// VIN decode never fills make/model/year as columns — they live in specs. Guarantee the object so
// the nested v-model binds below are safe (fetchItem also seeds it).
onMounted(() => {
  if (item.value && !item.value.specs) item.value.specs = {}
})
const specs = computed<VehicleSpecs>(() => item.value?.specs ?? {})

// Admin is internal/English — labels are not translated (pages/admin/** is i18n-exempt).
const FUEL_LABELS: Record<FuelType, string> = {
  petrol: 'Petrol',
  diesel: 'Diesel',
  electric: 'Electric',
  hybrid: 'Hybrid',
  phev: 'Plug-in hybrid',
  lpg: 'LPG',
  cng: 'CNG',
  hydrogen: 'Hydrogen',
  other: 'Other',
}
const TRANSMISSION_LABELS: Record<Transmission, string> = {
  manual: 'Manual',
  automatic: 'Automatic',
  semi_automatic: 'Semi-automatic',
  cvt: 'CVT',
  dct: 'Dual-clutch (DCT)',
}
const BODY_LABELS: Record<BodyType, string> = {
  sedan: 'Sedan',
  wagon: 'Wagon',
  hatchback: 'Hatchback',
  suv: 'SUV',
  coupe: 'Coupe',
  convertible: 'Convertible',
  van: 'Van',
  pickup: 'Pickup',
  minibus: 'Minibus',
  other: 'Other',
}
const DRIVE_LABELS: Record<DriveType, string> = {
  fwd: 'Front (FWD)',
  rwd: 'Rear (RWD)',
  awd: 'AWD',
  '4x4': '4×4',
}
const COLOR_LABELS: Record<VehicleColor, string> = {
  white: 'White',
  black: 'Black',
  silver: 'Silver',
  grey: 'Grey',
  blue: 'Blue',
  red: 'Red',
  green: 'Green',
  brown: 'Brown',
  beige: 'Beige',
  yellow: 'Yellow',
  orange: 'Orange',
  gold: 'Gold',
  other: 'Other',
}

const fuelOptions = FUEL_TYPES.map<OptionItem>(v => ({ label: FUEL_LABELS[v], value: v }))
const transmissionOptions = TRANSMISSIONS.map<OptionItem>(v => ({ label: TRANSMISSION_LABELS[v], value: v }))
const bodyOptions = BODY_TYPES.map<OptionItem>(v => ({ label: BODY_LABELS[v], value: v }))
const driveOptions = DRIVE_TYPES.map<OptionItem>(v => ({ label: DRIVE_LABELS[v], value: v }))
const colorOptions = VEHICLE_COLORS.map<OptionItem>(v => ({ label: COLOR_LABELS[v], value: v }))

const specNumberFields: { key: keyof VehicleSpecs; label: string }[] = [
  { key: 'enginePowerHp', label: 'Power (HP)' },
  { key: 'numberOfGears', label: 'Gears' },
  { key: 'co2EmissionGkm', label: 'CO₂ (g/km)' },
  { key: 'numberOfDoors', label: 'Doors' },
  { key: 'numberOfSeats', label: 'Seats' },
  { key: 'numberOfAxles', label: 'Axles' },
  { key: 'lengthMm', label: 'Length (mm)' },
  { key: 'widthMm', label: 'Width (mm)' },
  { key: 'heightMm', label: 'Height (mm)' },
  { key: 'wheelbaseMm', label: 'Wheelbase (mm)' },
  { key: 'weightEmptyKg', label: 'Empty weight (kg)' },
  { key: 'maxSpeedKmh', label: 'Max speed (km/h)' },
]

const priceLabel = computed(() => {
  const r = result.value
  if (!r || r.price == null) return ''
  return `${r.price} ${r.priceCurrency ?? ''}`.trim()
})

const badgeLabel = computed(() =>
  source.value === 'offline'
    ? 'Offline (free · partial)'
    : result.value?.cached
      ? 'From cache (free)'
      : 'Freshly decoded',
)
const badgeClass = computed(() =>
  source.value === 'offline' ? 'badge-offline' : result.value?.cached ? 'badge-cache' : 'badge-fresh',
)

interface PreviewRow {
  label: string
  value: string
}
const previewRows = computed<PreviewRow[]>(() => {
  const n = result.value?.normalized
  if (!n) return []
  const rows: PreviewRow[] = []
  const push = (label: string, value: string | number | undefined) => {
    if (value === undefined || value === '') return
    rows.push({ label, value: String(value) })
  }
  push('Manufacturer', n.manufacturer)
  push('Model', n.model)
  push('Year', n.yearOfManufacture)
  push('Fuel', n.fuelType ? FUEL_LABELS[n.fuelType] : undefined)
  push('Transmission', n.transmission ? TRANSMISSION_LABELS[n.transmission] : undefined)
  push('Body', n.bodyType ? BODY_LABELS[n.bodyType] : undefined)
  push('Drive', n.driveType ? DRIVE_LABELS[n.driveType] : undefined)
  push('Power (kW)', n.enginePowerKw)
  push('Power (HP)', n.enginePowerHp)
  push('Displacement (ccm)', n.engineDisplacementCcm)
  push('Gears', n.numberOfGears)
  push('Emission standard', n.emissionStandard)
  push('CO₂ (g/km)', n.co2EmissionGkm)
  push('Doors', n.numberOfDoors)
  push('Seats', n.numberOfSeats)
  push('Axles', n.numberOfAxles)
  push('Length (mm)', n.lengthMm)
  push('Width (mm)', n.widthMm)
  push('Height (mm)', n.heightMm)
  push('Wheelbase (mm)', n.wheelbaseMm)
  push('Empty weight (kg)', n.weightEmptyKg)
  push('Max speed (km/h)', n.maxSpeedKmh)
  return rows
})
</script>

<template>
  <section v-if="item" class="vehicle">
    <div class="head">
      <h3 class="heading">Vehicle (VIN)</h3>
      <p class="subheading">Decode a VIN to auto-fill the vehicle parameters, or edit them manually.</p>
    </div>

    <div class="vin-row">
      <div class="vin-field">
        <label class="label">VIN</label>
        <BaseInput v-model:value="item.vin" type="text" placeholder="17-character VIN" />
      </div>
      <div class="decode-actions">
        <button type="button" class="app-btn-alt decode-btn" :disabled="!canDecode" @click="decodeOffline">
          <Icon name="heroicons-outline:bolt" class="decode-icon" />
          Decode (free)
        </button>
        <button
          v-if="vincarioEnabled"
          type="button"
          class="app-btn decode-btn"
          :class="{ 'is-loading': decoding }"
          :disabled="!canDecode"
          @click="decode"
        >
          <Icon :name="decoding ? 'mdi:loading' : 'heroicons-outline:magnifying-glass'" class="decode-icon" />
          {{ decoding ? 'Decoding…' : 'Decode (full)' }}
        </button>
      </div>
    </div>

    <div class="fields-grid">
      <div class="field">
        <label class="label">Manufacturer</label>
        <BaseInput v-model:value="specs.manufacturer" type="text" placeholder="e.g. Audi" />
      </div>
      <div class="field">
        <label class="label">Model</label>
        <BaseInput v-model:value="specs.model" type="text" placeholder="e.g. A4" />
      </div>
      <div class="field">
        <label class="label">Year of manufacture</label>
        <BaseInput v-model:value="specs.yearOfManufacture" type="number" placeholder="e.g. 2018" />
      </div>

      <div class="field">
        <label class="label">Fuel type</label>
        <BaseSelect v-model:value="item.fuelType" :options="fuelOptions" :searchable="false" placeholder="—" />
      </div>
      <div class="field">
        <label class="label">Transmission</label>
        <BaseSelect
          v-model:value="item.transmission"
          :options="transmissionOptions"
          :searchable="false"
          placeholder="—"
        />
      </div>
      <div class="field">
        <label class="label">Body type</label>
        <BaseSelect v-model:value="item.bodyType" :options="bodyOptions" :searchable="false" placeholder="—" />
      </div>
      <div class="field">
        <label class="label">Drive type</label>
        <BaseSelect v-model:value="item.driveType" :options="driveOptions" :searchable="false" placeholder="—" />
      </div>
      <div class="field">
        <label class="label">Color</label>
        <BaseSelect v-model:value="item.color" :options="colorOptions" :searchable="false" placeholder="—" />
      </div>
      <div class="field">
        <label class="label">First registration</label>
        <BaseInput v-model:value="item.firstRegistrationDate" type="date" />
      </div>
      <div class="field">
        <label class="label">Engine power (kW)</label>
        <BaseInput v-model:value="item.enginePowerKw" type="number" placeholder="kW" />
      </div>
      <div class="field">
        <label class="label">Displacement (ccm)</label>
        <BaseInput v-model:value="item.engineDisplacementCcm" type="number" placeholder="ccm" />
      </div>
      <div class="field">
        <label class="label">Emission standard</label>
        <BaseInput v-model:value="specs.emissionStandard" type="text" placeholder="e.g. Euro 6" />
      </div>

      <div v-for="f in specNumberFields" :key="f.key" class="field">
        <label class="label">{{ f.label }}</label>
        <BaseInput v-model:value="specs[f.key]" type="number" :placeholder="f.label" />
      </div>
    </div>

    <BaseModal v-model:is-open="showResult" :size="ModalSize.Large" heading="VIN decode result" is-closable>
      <div v-if="result" class="decoded">
        <div class="meta">
          <span class="badge" :class="badgeClass">{{ badgeLabel }}</span>
          <span v-if="source !== 'offline' && !result.cached && priceLabel" class="price">Cost: {{ priceLabel }}</span>
          <span class="vin-code">{{ result.vin }}</span>
        </div>

        <p v-if="source === 'offline'" class="offline-note">
          A VIN encodes only manufacturer + model year. Use “Decode (full)” for engine, dimensions and emissions.
        </p>

        <p v-if="previewRows.length === 0" class="empty">No data could be decoded from this VIN.</p>

        <table v-else class="decoded-table">
          <tbody>
            <tr v-for="r in previewRows" :key="r.label">
              <th scope="row">{{ r.label }}</th>
              <td>{{ r.value }}</td>
            </tr>
          </tbody>
        </table>

        <div class="apply-controls">
          <BaseCheckbox v-model:value="overwrite" label="Overwrite already-filled fields" />
          <p class="note">Unchecked: only empty fields are filled — your manual values stay.</p>
        </div>

        <div class="modal-actions">
          <button type="button" class="app-btn-alt" @click="showResult = false">Cancel</button>
          <button type="button" class="app-btn" :disabled="previewRows.length === 0" @click="applyResult">
            Fill the form
          </button>
        </div>
      </div>
    </BaseModal>
  </section>
</template>

<style scoped>
.vehicle {
  @apply border-t border-app-border pt-5;
}

.head {
  @apply mb-4;
}

.heading {
  @apply text-lg font-medium text-app-text-strong;
}

.subheading {
  @apply mt-1 text-sm text-app-text-muted;
}

.vin-row {
  @apply flex flex-col gap-3 sm:flex-row sm:items-end;
}

.vin-field {
  @apply w-full sm:max-w-sm;
}

.label {
  @apply mb-1 block text-sm font-medium text-app-text;
}

.decode-actions {
  @apply flex flex-wrap gap-2;
}

.decode-btn {
  @apply w-auto items-center gap-2;

  &.is-loading .decode-icon {
    @apply animate-spin;
  }
}

.decode-icon {
  @apply h-5 w-5;
}

.fields-grid {
  @apply mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3;
}

.decoded {
  @apply flex flex-col gap-4;
}

.meta {
  @apply flex flex-wrap items-center gap-2;
}

.badge {
  @apply inline-flex items-center rounded-lg px-2 py-1 text-sm font-semibold;
}

.badge-cache {
  @apply bg-app-green/10 text-app-green;
}

.badge-fresh {
  @apply bg-app-primary/10 text-app-primary;
}

.badge-offline {
  @apply bg-app-amber/10 text-app-amber;
}

.offline-note {
  @apply text-xs text-app-text-muted;
}

.price {
  @apply text-sm text-app-text-muted;
}

.vin-code {
  @apply ml-auto font-mono text-sm text-app-text-muted;
}

.empty {
  @apply text-sm text-app-text-muted;
}

.decoded-table {
  @apply w-full border-collapse;

  tr {
    @apply border-b border-app-border last:border-b-0;
  }

  th {
    @apply py-1.5 pr-3 text-left align-top text-sm font-medium whitespace-nowrap text-app-text-muted;
  }

  td {
    @apply w-full py-1.5 text-right text-sm font-semibold break-words text-app-text-strong;
  }
}

.apply-controls {
  @apply flex flex-col gap-1;
}

.note {
  @apply text-xs text-app-text-muted;
}

.modal-actions {
  @apply flex justify-end gap-3;
}
</style>
