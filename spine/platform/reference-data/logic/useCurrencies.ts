import type { Currency } from '~/models'

export default function useCurrencies() {
  const currencies = useState<Currency[]>('currencies', () => [])

  const fetchCurrencies = async (force = false) => {
    if (currencies.value.length && !force) return
    currencies.value = await $fetch<Currency[]>('/api/currencies')
  }

  const findCurrency = (code: string): Currency | undefined => currencies.value.find(c => c.code === code)

  return { currencies, fetchCurrencies, findCurrency }
}
