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

  const deleteUser = async () => {
    useToast().success('User was successfully deleted')
  }

  const resetPassword = () => {
    useToast().success('E-mail has been sent')
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
    dispose,
  }
}
