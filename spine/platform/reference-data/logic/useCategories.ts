import type { Category, CategoryParam } from '~/models'

export default function useCategories() {
  const categories = useState<Category[]>('categories', () => [])
  const categoryParams = useState<CategoryParam[]>('categoryParams', () => [])

  const fetchCategories = async (force = false) => {
    if (categories.value.length && !force) return
    categories.value = await $fetch<Category[]>('/api/categories')
  }

  const fetchCategoryParams = async (force = false) => {
    if (categoryParams.value.length && !force) return
    categoryParams.value = await $fetch<CategoryParam[]>('/api/category-params')
  }

  const findCategory = (idCategory: string): Category | undefined => categories.value.find(c => c.id === idCategory)
  const findCategoryParam = (idParam: number): CategoryParam | undefined =>
    categoryParams.value.find(c => c.id === idParam)

  return { categories, categoryParams, fetchCategories, fetchCategoryParams, findCategory, findCategoryParam }
}
