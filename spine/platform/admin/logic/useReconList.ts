import { useToast } from 'vue-toastification'

export type FioAccount = 'CZK' | 'EUR'

export interface FioMovement {
  account: FioAccount
  fioId: string
  amount: string
  currency: string
  vs: string | null
  counterAccount: string | null
  counterName: string | null
  message: string | null
  paidOn: number
  status: string
}

// Fio reconciliation queue: unmatched bank movements + a manual "dismiss" (handled / refunded).
export default function useReconList() {
  const {
    items: movements,
    total,
    loading,
    fetchPage,
    refresh,
  } = useAdminPagedResource<FioMovement, { page: number; pageSize: number; q?: string }>(
    'admin:recon',
    '/api/admin/reconciliation',
  )

  const dismiss = async (m: FioMovement) => {
    try {
      await $fetch('/api/admin/reconciliation/resolve', {
        method: 'POST',
        body: { account: m.account, fioId: m.fioId },
      })
      useToast().success('Movement dismissed')
      await refresh()
    } catch (e) {
      useToast().error(apiErrorMessage(e))
    }
  }

  return { movements, total, loading, fetchPage, dismiss, dispose: () => {} }
}
