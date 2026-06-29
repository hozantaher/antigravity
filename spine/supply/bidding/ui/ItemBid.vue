<script lang="ts" setup>
import { useToast } from 'vue-toastification'
import type BaseValidator from '~/models/BaseValidator'
import type { Item, Price } from '~/models'

const props = defineProps<{
  item: Item
}>()
const router = useRouter()
const toast = useToast()
const { user, isLogged, backlink, isEligibleToBid, emailVerified } = useUser()
const { t } = useI18n()
const localePath = useLocalePath()

const minBidAmount = computed(() => (itemCurrentPrice(props.item)?.amount ?? 0) + (props.item.minBid?.amount ?? 1))
const minBidValidator = computed(
  () =>
    ({
      validator: (val: any): boolean => val && val >= minBidAmount.value,
      message: t('minBidValidator', {
        minBid: formatPrice({ amount: minBidAmount.value, currency: props.item.priceFrom?.currency } as Price),
      }),
    }) as BaseValidator,
)
const bidPlaceholder = computed(() =>
  t('enterAmount', {
    amount: formatPrice({ amount: minBidAmount.value, currency: props.item.priceFrom?.currency } as Price),
  }),
)

const bidAmount = ref<number>()
const pending = ref(false)

const mustConfirm = computed(
  () => (bidAmount.value ?? 0) - (itemCurrentPrice(props.item)?.amount ?? 0) > 5 * (props.item.minBid?.amount ?? 1),
)

const placeBid = async () => {
  if (!isLogged.value) {
    router.push(localePath('/sign'))
    toast.warning(t('signInFirst'))
    backlink.value = localePath(`/item/${props.item.id}`)
    return
  }

  if (!isEligibleToBid.value) {
    if (!hasDepositPaid(user.value!)) {
      backlink.value = localePath(`/item/${props.item.id}`)
      router.push(localePath({ path: '/profile/billing', query: { deposit: '1' } }))
      toast.warning(t('depositFirst'))
      return
    }

    if (!emailVerified.value || !user.value!.phone) {
      toast.warning(t('bidEmailAndPhone'))
      backlink.value = localePath(`/item/${props.item.id}`)
      router.push(localePath('/profile'))
      return
    }

    toast.error(t('notEligibleToBid'))
    return
  }

  if (bidAmount.value) {
    if (bidAmount.value < minBidAmount.value) return
    if (pending.value) return // a fast double-click would fire a second bid that 400s and toasts a false error

    pending.value = true
    try {
      await useItemDetail().placeBid(bidAmount.value)
      bidAmount.value = undefined
    } catch {
      toast.error(t('toastError'))
    } finally {
      pending.value = false
    }
  }
}
</script>

<template>
  <div class="bid">
    <BaseInput
      v-model:value="bidAmount"
      type="number"
      :validators="[minBidValidator]"
      class="bid-input"
      :placeholder="bidPlaceholder"
    >
      <template #suffix> EUR </template>
    </BaseInput>
    <BaseConfirmation
      v-if="mustConfirm"
      :heading="`${t('yourBidIs')} ${formatAmount(bidAmount!)}€`"
      :subheading="t('confirmBid')"
      @on-confirm="placeBid"
    >
      <button type="button" class="app-btn-auction bid-btn" :disabled="pending">
        {{ t('placeBid') }}
      </button>
    </BaseConfirmation>
    <button v-else type="button" class="app-btn-auction bid-btn" :disabled="pending" @click="placeBid">
      {{ t('placeBid') }}
    </button>
  </div>
</template>

<style scoped>
.bid {
  @apply flex flex-col items-center gap-3 xl:flex-row;
}

.bid-input {
  @apply w-full;
}

.bid-btn {
  @apply w-auto items-center self-stretch whitespace-nowrap uppercase;
}
</style>
