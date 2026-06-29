import type { User } from '~/models'

export interface UserListParams {
  page: number
  pageSize: number
  q?: string
}

export default function useUserList() {
  const {
    items: users,
    total,
    loading,
    fetchPage,
  } = useAdminPagedResource<User, UserListParams>('admin:userList', '/api/admin/users')
  return { users, total, loading, fetchPage, dispose: () => {} }
}
