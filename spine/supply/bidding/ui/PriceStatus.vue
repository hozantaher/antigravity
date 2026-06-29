<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import ItemBid from './ItemBid.vue'
import { ItemStatus } from '~/models'
import type { Item, Price } from '~/models'

const props = defineProps<{
  item: Item
}>()

const { t } = useI18n()
const { user, isLogged, backlink } = useUser()
const router = useRouter()
const route = useRoute()
const localePath = useLocalePath()
const toast = useToast()

// The viewer is the winner of this sold item → show the settlement entry point. The winner pays the
// final price minus the held deposit here (closes the money loop).
const isWinner = computed(() => !!props.item.winner?.id && props.item.winner.id === user.value?.id)
// Stripe Checkout return: ?settlement=success → open the wizard on the verifying screen.
const settlementIntent = computed<'verify' | undefined>(() =>
  route.query.settlement === 'success' ? 'verify' : undefined,
)

// Status derived off the shared 1s ticker (one app-wide interval) instead of a per-instance timer.
const { status } = useLiveItemStatus(() => props.item)

const loading = ref(false)
const fieldPrice = ref()
const showOfferPrice = ref(false)
const offerPrice = ref<Price>({ currency: props.item.priceFrom?.currency })

const submitOffer = async () => {
  if (!isFormValid([fieldPrice])) return
  if (!isLogged.value) {
    router.push(localePath('/sign'))
    toast.warning(t('signInFirst'))
    backlink.value = localePath(`/item/${props.item.id}`)
    return
  }

  loading.value = true
  try {
    await $fetch('/api/contact', {
      method: 'POST',
      body: { type: 'offer', price: offerPrice.value, itemId: props.item.id, userId: user.value?.id },
    })
    toast.success(t('formSentSuccessMsg'))
    offerPrice.value.amount = undefined
    showOfferPrice.value = false
  } catch {
    toast.error(t('toastError'))
  }
  loading.value = false
}
</script>

<template>
  <div v-if="status">
    <p v-if="status === ItemStatus.AuctionLive && !isMinPriceReached(item) && item.bids.length > 0" class="not-met">
      {{ t('minBidNotMet') }}
    </p>
    <div class="panel">
      <ItemContact v-if="status === ItemStatus.BuyNow && (item.email || item.phone)" :item="item" />
      <template v-if="status === ItemStatus.BuyNow && !item.email && !item.phone">
        {{ t('noContactInfo') }}
      </template>

      <template v-if="status === ItemStatus.AuctionLive">
        <ItemBid :item="item" />
      </template>

      <template v-if="status === ItemStatus.AuctionSoon">
        {{ t('itemStatus.auctionSoon') }}
      </template>

      <template v-if="status === ItemStatus.AuctionProcessing">
        {{ t('itemStatus.auctionProcessing') }}
      </template>

      <template v-if="status === ItemStatus.AuctionEnd">
        <span v-if="item.winner">{{ t('itemStatus.auctionEnd', { name: item.winner.name }) }}</span>
        <span v-else>{{ t('itemStatus.auctionEndNoWinner') }}</span>
      </template>

      <template v-if="status === ItemStatus.Sold">
        {{ t('itemStatus.sold') }}
        <span v-if="item.winner"
          >- <strong>{{ parseUserIdentifier(item.winner.id) }} {{ t('infoWon') }}!</strong></span
        >
        <SettlementCard
          v-if="isWinner"
          :item-id="item.id"
          :auto-open="!!settlementIntent"
          :intent="settlementIntent"
          class="settlement-mount"
        />
      </template>
      <div v-if="status === ItemStatus.BuyNow && !showOfferPrice" class="offer-toggle">
        <button type="button" class="app-text-btn offer-toggle-btn" @click="showOfferPrice = true">
          <Icon name="mdi:offer" class="offer-icon" />
          {{ t('offerPrice') }}
        </button>
      </div>
      <div v-if="showOfferPrice" class="offer-form">
        <BaseInput
          ref="fieldPrice"
          v-model:value="offerPrice.amount"
          type="number"
          class="offer-input"
          :placeholder="t('enterOffer')"
          required
        >
          <template #suffix>
            {{ offerPrice.currency?.code }}
          </template>
        </BaseInput>
        <button type="button" class="app-btn offer-submit" :disabled="loading" @click="submitOffer">
          {{ t('sendOffer') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.not-met {
  @apply truncate px-4 !pt-0 pb-4 text-sm font-medium;
}

.panel {
  @apply bg-app-surface-muted px-4 py-2 sm:py-4;
}

.settlement-mount {
  @apply mt-4;
}

.offer-toggle {
  @apply pt-2;
}

.offer-toggle-btn {
  @apply flex items-center gap-2;
}

.offer-icon {
  @apply h-6 w-6 text-app-primary;
}

.offer-form {
  @apply flex flex-col items-center gap-3 pt-2 xl:flex-row;
}

.offer-input {
  @apply w-full;
}

.offer-submit {
  @apply w-auto items-center self-start whitespace-nowrap uppercase;
}
</style>
