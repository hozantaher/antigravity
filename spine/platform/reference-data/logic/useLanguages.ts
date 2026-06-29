import type { Language } from '~/models'

export default function useLanguages() {
  const languages = useState<Language[]>('languages', () => [])

  const fetchLanguages = async (force = false) => {
    if (languages.value.length && !force) return
    languages.value = await $fetch<Language[]>('/api/languages')
  }

  const findLanguage = (code: string): Language | undefined => languages.value.find(l => l.code === code)

  return { languages, fetchLanguages, findLanguage }
}
