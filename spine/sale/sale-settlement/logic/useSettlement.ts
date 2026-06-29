import type { IssueSaleTransferResult, Settlement } from '~/models'

// The single settlement composable, mirroring useDeposit. State is shared per item via a keyed
// useState so the card + the wizard see one status. Returns the wizard-facing status plus the three
// mutating actions. 409 (already settled — a cron/webhook beat the wizard) is the happy path, surfaced
// to the caller to short-circuit to success.
export default function useSettlement(itemId: string) {
  const status = useState<Settlement | undefined>(`settlement:${itemId}`, () => undefined)

  // Read-only refresh; keeps the last known state on a transient fetch error so a flaky poll tick
  // doesn't flash the UI back.
  const fetchStatus = async (): Promise<Settlement | undefined> => {
    try {
      status.value = await $fetch<Settlement>(`/api/item/${itemId}/settlement`)
    } catch {
      /* keep last known state */
    }
    return status.value
  }

  // POST — find-or-creates the sale invoice and returns bank details (or a 'completed' state when the
  // deposit fully covered the price).
  const startTransfer = (): Promise<IssueSaleTransferResult> =>
    $fetch<IssueSaleTransferResult>(`/api/item/${itemId}/settlement/transfer`, { method: 'POST' })

  // Returns the Stripe Checkout URL; the caller redirects the whole window there.
  const startCheckout = (): Promise<{ url: string }> =>
    $fetch<{ url: string }>(`/api/item/${itemId}/settlement/checkout`, { method: 'POST' })

  const isPaid = computed(() => status.value?.state === 'paid' || status.value?.state === 'completed')
  const isPending = computed(() => status.value?.state === 'pending')
  const isCompleted = computed(() => status.value?.state === 'completed')
  const isDue = computed(() => status.value?.state === 'due')

  return { status, isPaid, isPending, isCompleted, isDue, fetchStatus, startTransfer, startCheckout }
}
