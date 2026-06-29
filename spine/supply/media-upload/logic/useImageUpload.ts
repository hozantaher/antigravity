// Posts a single image to the admin upload endpoint, which stores it in Firebase Storage
// (public/ads/{itemId}/) and returns a tokened download URL. Bearer auth is added by
// plugins/api.client.ts; ofetch sets the multipart boundary from the FormData body.
export const useImageUpload = () => {
  const pending = ref(false)
  const error = ref<string | null>(null)

  const execute = async (file: File, itemId: string): Promise<string | null> => {
    pending.value = true
    error.value = null
    try {
      const form = new FormData()
      form.append('itemId', itemId)
      form.append('file', file)
      const res = await $fetch<{ url: string }>('/api/admin/uploads', { method: 'POST', body: form })
      return res.url
    } catch (e) {
      error.value = apiErrorMessage(e, 'Upload failed')
      return null
    } finally {
      pending.value = false
    }
  }

  return { execute, pending, error }
}
