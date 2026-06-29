import type { Category } from '~/models'

// Admin is internal/English; names mirror the i18n `<id>Category` keys (en.yml). Hardcoded
// (not t()) because i18n messages are lazy-loaded, so 'en' isn't available in a cz session.
const CATEGORY_LABELS: Record<string, string> = {
  car: 'Cars',
  moto: 'Motorbikes',
  motorhome: 'Motorhomes',
  vut75: 'Vans / Trucks up to 7.5T',
  to75: 'Trucks over 7.5T',
  av: 'Agricultural Vehicles',
  stt: 'Semitrailer-Truck',
  t: 'Trailers',
  st: 'Semitrailers',
  cm: 'Construction machinery',
  bus: 'Buses',
  ft: 'Forklifts',
  others: 'Others',
}

export const useAdminCategoryLabel = () => {
  const categoryLabel = (category: Category): string => CATEGORY_LABELS[category.id] ?? category.title
  return { categoryLabel }
}
