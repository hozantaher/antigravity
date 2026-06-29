export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
