import { useToast } from 'vue-toastification'
import type { Item } from '~/models'

export interface ItemListParams {
  page: number
  pageSize: number
  q?: string
  visibility?: 'visible' | 'hidden' | 'all'
}

export default function useItemList() {
  const { items, total, loading, fetchPage, refresh } = useAdminPagedResource<Item, ItemListParams>(
    'admin:itemList',
    '/api/admin/items',
  )

  const updateVisibility = async (item: Item) => {
    try {
      await $fetch(`/api/admin/item/${item.id}`, { method: 'PUT', body: { hidden: !item.hidden } })
      useToast().success('Visibility changed succesfully')
      await refresh()
    } catch (e) {
      useToast().error(apiErrorMessage(e))
    }
  }

  const deleteItem = async (item: Item) => {
    try {
      await $fetch(`/api/admin/item/${item.id}`, { method: 'DELETE' })
      useToast().success('Item deleted succesfully')
      await refresh()
    } catch (e) {
      useToast().error(apiErrorMessage(e))
    }
  }

  return { items, total, loading, fetchPage, refresh, deleteItem, updateVisibility, dispose: () => {} }
}
