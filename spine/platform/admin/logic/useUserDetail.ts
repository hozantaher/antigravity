import { useToast } from 'vue-toastification'
import type { Invoice, Paginated, User } from '~/models'

export default function useUserDetail() {
  const user = useState<User | undefined>('admin:userDetail', () => undefined)
  const userInvoices = useState<Invoice[] | undefined>('admin:userInvoices', () => undefined)
  const invoicesTotal = useState('admin:userInvoicesTotal', () => 0)
  const invoicesPage = useState('admin:userInvoicesPage', () => 1)
  const invoicesPageSize = 10

  const fetchInvoices = async () => {
    if (!user.value) return
    const res = await $fetch<Paginated<Invoice>>(`/api/admin/user/${user.value.id}/invoices`, {
      query: { page: invoicesPage.value, pageSize: invoicesPageSize },
    }).catch(() => ({ items: [] as Invoice[], total: 0, page: 1, pageSize: invoicesPageSize }))
    userInvoices.value = res.items
    invoicesTotal.value = res.total
  }

  const fetchUser = async (id: string) => {
    user.value = await $fetch<User>(`/api/admin/user/${id}`)
    invoicesPage.value = 1
    await fetchInvoices()
  }

  watch(invoicesPage, fetchInvoices)

  // Anonymize + delete the account (DB soft-delete + Firebase). Takes an explicit id because the
  // caller navigates away first, which disposes user.value.
  const deleteUser = async (id: string) => {
    try {
      await $fetch(`/api/admin/user/${id}`, { method: 'DELETE' })
      useToast().success('User was successfully deleted')
    } catch (e) {
      useToast().error(apiErrorMessage(e))
    }
  }

  const resetPassword = async () => {
    if (!user.value) return
    try {
      await $fetch(`/api/admin/user/${user.value.id}/reset-password`, { method: 'POST' })
      useToast().success('Password reset e-mail sent')
    } catch (e) {
      useToast().error(apiErrorMessage(e))
    }
  }

  const setAdmin = async (grant: boolean) => {
    if (!user.value) return
    try {
      user.value = await $fetch<User>(`/api/admin/user/${user.value.id}/role`, { method: 'POST', body: { grant } })
      useToast().success(grant ? 'Admin granted' : 'Admin revoked')
    } catch (e) {
      useToast().error(apiErrorMessage(e))
    }
  }

  const dispose = () => {
    user.value = undefined
    userInvoices.value = undefined
  }

  return {
    user: computed(() => user.value),
    invoices: computed(() => userInvoices.value),
    invoicesTotal: computed(() => invoicesTotal.value),
    invoicesPage,
    invoicesPageSize,
    fetchUser,
    fetchInvoices,
    deleteUser,
    resetPassword,
    setAdmin,
    dispose,
  }
}
