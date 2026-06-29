import type { Country } from '~/models'

export default function useCountries() {
  const countries = useState<Country[]>('countries', () => [])

  const fetchCountries = async (force = false) => {
    if (countries.value.length && !force) return
    countries.value = await $fetch<Country[]>('/api/countries')
  }

  const findCountryByCode2 = (code: string): Country | undefined => countries.value.find(c => c.code2 === code)
  const findCountryByCode3 = (code: string): Country | undefined => countries.value.find(c => c.code3 === code)

  return { countries, fetchCountries, findCountryByCode2, findCountryByCode3 }
}
