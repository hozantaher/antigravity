<script setup lang="ts">
const appColors = [
  { name: 'app-primary · brand red', hex: '#db302f', tone: 'primary' },
  { name: 'app-red · auction/destructive', hex: '#db302f', tone: 'red' },
  { name: 'app-green · buy-now/success', hex: '#16a34a', tone: 'green' },
  { name: 'app-amber · pending/favorite', hex: '#f59e0b', tone: 'amber' },
  { name: 'app-bg', hex: '#f8fafc', tone: 'bg' },
  { name: 'app-surface', hex: '#ffffff', tone: 'surface' },
  { name: 'app-surface-muted', hex: '#f1f5f9', tone: 'surface-muted' },
  { name: 'app-border', hex: '#e2e8f0', tone: 'border' },
  { name: 'app-border-strong', hex: '#cbd5e1', tone: 'border-strong' },
  { name: 'app-text', hex: '#334155', tone: 'text' },
  { name: 'app-text-muted', hex: '#64748b', tone: 'text-muted' },
  { name: 'app-text-strong', hex: '#0f172a', tone: 'text-strong' },
  { name: 'app-black', hex: '#000000', tone: 'black' },
  { name: 'app-white', hex: '#ffffff', tone: 'white' },
]

const grays = [
  { name: 'gray-100', hex: '#f3f4f6', tone: 'g100' },
  { name: 'gray-300', hex: '#d1d5db', tone: 'g300' },
  { name: 'gray-500', hex: '#6b7280', tone: 'g500' },
  { name: 'gray-700', hex: '#374151', tone: 'g700' },
  { name: 'gray-900', hex: '#111827', tone: 'g900' },
]

const families = [
  { token: 'font-sans · Lato', cls: 'is-sans', sample: 'The quick brown fox jumps over 0123456789' },
  { token: 'font-mono · Fira Code', cls: 'is-mono', sample: 'const price = 1_240_000' },
]

const scale = ['text-xs', 'text-14', 'text-16', 'text-18', 'text-24', 'text-32']
const toneOf = (token: string) => `is-${token.replace('text-', '')}`
</script>

<template>
  <PlaygroundSection id="foundations" title="Foundations" subtitle="Design tokens — colour, type, buttons, surfaces.">
    <PlaygroundSpecimen
      name="Colour tokens"
      tag="@theme"
      description="Accents (red is primary — no blue) plus semantic surface/text tokens, as bg-app-* / text-app-* / border-app-* utilities."
    >
      <div class="pg-swatches">
        <PlaygroundSwatch v-for="c in appColors" :key="c.name" :name="c.name" :hex="c.hex" :tone="c.tone" />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="Neutral ramp — slate (remapped gray ramp)"
      tag="tailwind"
      description="The Tailwind gray-* ramp is remapped to slate, so existing gray-* classes render cool slate."
    >
      <div class="pg-swatches">
        <PlaygroundSwatch v-for="c in grays" :key="c.name" :name="c.name" :hex="c.hex" :tone="c.tone" />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="Font families" surface="white" :chips="['font-sans', 'font-mono']">
      <div class="pg-type-list">
        <div v-for="f in families" :key="f.token" class="pg-type-row">
          <span class="pg-type-token">{{ f.token }}</span>
          <p class="pg-type-sample" :class="f.cls">{{ f.sample }}</p>
        </div>
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="Type scale" surface="white" description="6-step scale — 12 / 14 / 16 / 18 / 24 / 32 px.">
      <div class="pg-scale">
        <div v-for="s in scale" :key="s" class="pg-scale-row">
          <span class="pg-scale-tag">{{ s }}</span>
          <span class="pg-scale-demo" :class="toneOf(s)">Auction24</span>
        </div>
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="Buttons"
      tag="@utility"
      :chips="['app-btn', 'app-btn-alt', 'app-btn-danger', 'app-btn-admin', 'app-icon-btn', 'app-text-btn', 'app-link']"
    >
      <div class="pg-btn-stack">
        <div class="pg-btn-row">
          <button type="button" class="app-btn pg-btn">Primary</button>
          <button type="button" class="app-btn-alt pg-btn">Secondary</button>
          <button type="button" class="app-btn-danger pg-btn">Danger</button>
          <button type="button" class="app-btn-admin pg-btn">Admin</button>
          <button type="button" class="app-btn pg-btn" disabled>Disabled</button>
        </div>
        <div class="pg-btn-row">
          <button type="button" class="app-icon-btn pg-iconbtn">
            <Icon name="heroicons-outline:heart" class="pg-iconbtn-icon" />
          </button>
          <button type="button" class="app-text-btn">Text button</button>
          <a class="app-link" href="#">Inline link</a>
        </div>
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="Panel" tag="@utility" :chips="['app-panel', 'app-panel-heading', 'app-panel-body']">
      <div class="app-panel pg-demo-panel">
        <div class="app-panel-heading">Panel heading</div>
        <div class="app-panel-body">
          The shared white card used across profile, billing and detail pages — rounded, soft shadow, hairline ring.
        </div>
      </div>
    </PlaygroundSpecimen>
  </PlaygroundSection>
</template>

<style scoped>
.pg-swatches {
  @apply grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5;
}

.pg-type-list {
  @apply flex flex-col gap-5;
}

.pg-type-row {
  @apply flex flex-col gap-1;
}

.pg-type-token {
  @apply font-mono text-xs text-gray-400;
}

.pg-type-sample {
  @apply text-2xl text-gray-900;

  &.is-sans {
    @apply font-sans;
  }

  &.is-mono {
    @apply font-mono;
  }
}

.pg-scale {
  @apply flex flex-col gap-3;
}

.pg-scale-row {
  @apply flex items-baseline gap-4;
}

.pg-scale-tag {
  @apply w-20 shrink-0 font-mono text-xs text-gray-400;
}

.pg-scale-demo {
  @apply font-bold text-gray-900;

  &.is-xs {
    @apply text-xs;
  }

  &.is-14 {
    @apply text-14;
  }

  &.is-16 {
    @apply text-16;
  }

  &.is-18 {
    @apply text-18;
  }

  &.is-24 {
    @apply text-24;
  }

  &.is-32 {
    @apply text-32;
  }
}

.pg-btn-stack {
  @apply flex flex-col gap-4;
}

.pg-btn-row {
  @apply flex flex-wrap items-center gap-3;
}

.pg-btn {
  @apply w-auto;
}

.pg-iconbtn {
  @apply h-10 w-10 justify-center bg-gray-100 hover:bg-gray-200;
}

.pg-iconbtn-icon {
  @apply h-5 w-5;
}

.pg-demo-panel {
  @apply max-w-md;
}
</style>
