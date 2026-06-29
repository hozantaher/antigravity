import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuthStore } from '../store/authStore.js'

export default function RequireAuth() {
  const user = useAuthStore((s) => s.user)
  const loading = useAuthStore((s) => s.loading)
  const location = useLocation()

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: 'var(--muted)',
        fontSize: 16, fontFamily: 'sans-serif',
      }}>
        Načítám…
      </div>
    )
  }

  // Preserve the attempted destination so login can return the operator there
  // (deep-links / bookmarks to a protected route survive the auth bounce).
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />

  return <Outlet />
}
