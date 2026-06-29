import { useToast } from 'vue-toastification'
import type { ApiTokenCreated, ApiTokenRow } from '~/models'

export interface ApiTokenListParams {
  page: number
  pageSize: number
}

export default function useApiTokens() {
  const { items, total, loading, fetchPage, refresh } = useAdminPagedResource<ApiTokenRow, ApiTokenListParams>(
    'admin:apiTokens',
    '/api/admin/api-tokens',
  )

  // Returns the created token (raw value shown once) so the caller can reveal it.
  const createToken = async (name: string): Promise<ApiTokenCreated | null> => {
    try {
      const created = await $fetch<ApiTokenCreated>('/api/admin/api-tokens', { method: 'POST', body: { name } })
      useToast().success('API token created')
      await refresh()
      return created
    } catch (e) {
      useToast().error(apiErrorMessage(e))
      return null
    }
  }

  const deleteToken = async (id: string) => {
    try {
      await $fetch(`/api/admin/api-tokens/${id}`, { method: 'DELETE' })
      useToast().success('API token revoked')
      await refresh()
    } catch (e) {
      useToast().error(apiErrorMessage(e))
    }
  }

  return { items, total, loading, fetchPage, refresh, createToken, deleteToken, dispose: () => {} }
}
