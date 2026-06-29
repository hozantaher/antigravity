import type { Invoice, Paginated } from '~/models'

export default function useInvoices() {
  const invoices = useState<Invoice[] | undefined>('invoices', () => undefined)
  const total = useState('invoices:total', () => 0)
  const page = useState('invoices:page', () => 1)
  const pageSize = 10

  const fetchInvoices = async () => {
    const res = await $fetch<Paginated<Invoice>>('/api/invoices', { query: { page: page.value, pageSize } })
    invoices.value = res.items
    total.value = res.total
  }

  watch(page, fetchInvoices)

  return {
    invoices: computed(() => invoices.value),
    total: computed(() => total.value),
    page,
    pageSize,
    fetchInvoices,
  }
}
