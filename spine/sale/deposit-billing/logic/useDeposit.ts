import type { DepositBankDetails, DepositCurrency, DepositStatus } from '~/models'

export default function useDeposit() {
  const status = useState<DepositStatus | undefined>('deposit:status', () => undefined)

  // Read-only refresh; keeps the last known state on a transient fetch error so a
  // flaky poll tick doesn't flash the UI back to "none".
  const fetchStatus = async (): Promise<DepositStatus | undefined> => {
    try {
      status.value = await $fetch<DepositStatus>('/api/deposit/status')
    } catch {
      /* keep last known state */
    }
    return status.value
  }

  // POST, not a query — issues (or reuses) the unpaid proforma server-side.
  const startTransfer = (currency: DepositCurrency): Promise<DepositBankDetails> =>
    $fetch<DepositBankDetails>('/api/deposit/transfer', { method: 'POST', body: { currency } })

  // Returns the Stripe Checkout URL; the caller redirects the whole window there.
  const startCheckout = (currency: DepositCurrency): Promise<{ url: string }> =>
    $fetch<{ url: string }>('/api/deposit/checkout', { method: 'POST', body: { currency } })

  const isPaid = computed(() => status.value?.state === 'paid')
  const isPending = computed(() => status.value?.state === 'pending')

  return { status, isPaid, isPending, fetchStatus, startTransfer, startCheckout }
}
