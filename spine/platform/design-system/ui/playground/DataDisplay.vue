<script setup lang="ts">
import { mockBids, mockInvoices } from './fixtures'

const page1 = ref(2)
const page2 = ref(1)
const invPage = ref(1)

// index 0 + isMine → winning (green); index 1 + isMine → your other bid (red); rest neutral.
const bidRows = [
  { bid: mockBids[0]!, name: 'You', isMine: true },
  { bid: mockBids[1]!, name: 'You', isMine: true },
  { bid: mockBids[2]!, name: 'Karel Novák', isMine: false },
  { bid: mockBids[3]!, name: 'Eva Horáková', isMine: false },
]

const avatars = ['Jane Doe', 'Karel Novák', 'Auction24', 'X']
</script>

<template>
  <PlaygroundSection id="data" title="Data display" subtitle="Pagination, tables, avatars, bid rows.">
    <PlaygroundSpecimen
      name="BasePagination"
      tag="Base"
      surface="white"
      :chips="['total', 'pageSize', 'page', 'variant']"
    >
      <div class="pg-stack-lg">
        <div>
          <p class="pg-sub">variant: default</p>
          <BasePagination v-model:page="page1" :total="137" :page-size="12" />
        </div>
        <div>
          <p class="pg-sub">variant: admin</p>
          <BasePagination v-model:page="page2" :total="137" :page-size="12" variant="admin" />
        </div>
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="Invoices"
      tag="component"
      surface="white"
      :chips="['invoices', 'total', 'pageSize', 'slot:action']"
    >
      <Invoices v-model:page="invPage" :invoices="mockInvoices" :total="mockInvoices.length" :page-size="5">
        <template #action>
          <button type="button" class="app-btn pg-btn">New request</button>
        </template>
      </Invoices>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="LettersAvatar" tag="component" surface="white" :chips="['name']">
      <div class="pg-avatars">
        <LettersAvatar v-for="n in avatars" :key="n" :name="n" />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="BidRow"
      tag="component"
      surface="white"
      :chips="['bid', 'index', 'isMine', 'name', 'to']"
      description="Green = winning bid (index 0), red = your other bids."
    >
      <ul class="pg-bid-list">
        <BidRow v-for="(r, i) in bidRows" :key="i" :bid="r.bid" :index="i" :is-mine="r.isMine" :name="r.name" />
      </ul>
    </PlaygroundSpecimen>
  </PlaygroundSection>
</template>

<style scoped>
.pg-stack-lg {
  @apply flex flex-col gap-6;
}

.pg-sub {
  @apply mb-1 font-mono text-xs text-gray-400;
}

.pg-avatars {
  @apply flex items-center gap-3;
}

.pg-bid-list {
  @apply divide-y divide-gray-200;
}

.pg-btn {
  @apply w-auto;
}
</style>
