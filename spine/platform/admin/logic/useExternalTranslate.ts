export default function useExternalTranslate() {
  // Batches the whole array into one /api/translate request (DeepL handles up to 50 texts per
  // call); keeps the { text }[] shape its callers in useAdminItem rely on.
  const translateDeepl = async (text: string | string[], code: string, sourceCode?: string) => {
    const texts = Array.isArray(text) ? text : [text]
    if (!texts.length) return []
    const r = await $fetch<{ texts: string[] }>('/api/translate', {
      method: 'POST',
      body: { text: texts, code, sourceCode },
    })
    return texts.map((_, i) => ({ text: r.texts[i] ?? '' }))
  }

  return { translateDeepl }
}
