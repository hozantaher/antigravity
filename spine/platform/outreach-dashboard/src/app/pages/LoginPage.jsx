import { useState } from 'react'
import { Navigate, useNavigate, useLocation } from 'react-router-dom'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '../../firebaseInit.js'
import { useAuthStore } from '../../store/authStore.js'
import '../styles/tokens.css'

const ERR_MAP = {
  'auth/invalid-credential': 'Nesprávný email nebo heslo.',
  'auth/user-not-found': 'Účet neexistuje.',
  'auth/wrong-password': 'Nesprávné heslo.',
  'auth/too-many-requests': 'Příliš mnoho pokusů. Zkuste to za chvíli.',
  'auth/user-disabled': 'Tento účet byl deaktivován.',
  'auth/invalid-email': 'Neplatná emailová adresa.',
}

const inputStyle = {
  font: 'inherit',
  fontSize: 'var(--app-text-base)',
  color: 'var(--app-text)',
  background: 'var(--app-surface-sunk)',
  border: '1px solid var(--app-border)',
  borderRadius: 'var(--app-radius-sm)',
  padding: '8px 12px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const loading = useAuthStore((s) => s.loading)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  // Where to land after auth: the route the operator originally tried (captured
  // by RequireAuth in location.state.from), else the overview.
  const from = location.state?.from
  const dest = from ? `${from.pathname || '/'}${from.search || ''}` : '/'

  // While Firebase resolves the persisted session, show the same calm spinner as
  // RequireAuth instead of flashing the login form to an already-authed operator.
  if (loading) {
    return (
      <div className="app-shell" style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: 'var(--app-text-muted)',
        fontSize: 16, background: 'var(--app-bg)',
      }}>
        Načítám…
      </div>
    )
  }
  // Already logged in — redirect to the attempted destination (or /).
  if (user) return <Navigate to={dest} replace />

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signInWithEmailAndPassword(auth, email, password)
      navigate(dest, { replace: true })
    } catch (err) {
      setError(ERR_MAP[err.code] || 'Přihlášení selhalo. Zkuste to znovu.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="app-shell"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--app-bg)',
      }}
    >
      <div style={{
        width: '100%',
        maxWidth: 380,
        background: 'var(--app-surface)',
        border: '1px solid var(--app-border)',
        borderRadius: 'var(--app-radius-lg)',
        padding: '40px 36px',
        boxShadow: 'var(--app-shadow)',
      }}>
        {/* Logo */}
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 8,
          marginBottom: 28,
          paddingBottom: 20,
          borderBottom: '1px solid var(--app-border)',
        }}>
          <span aria-hidden="true" style={{ fontSize: 22, color: 'var(--app-accent)', lineHeight: 1, transform: 'translateY(1px)' }}>⚗</span>
          <span style={{
            fontFamily: 'var(--app-font-serif)', fontSize: 'var(--app-text-xl)',
            fontWeight: 500, color: 'var(--app-text)', letterSpacing: '0.01em',
          }}>Hozan</span>
          <span style={{
            fontFamily: 'var(--app-font-sans)', fontSize: 'var(--app-text-xs)',
            color: 'var(--app-text-soft)', fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>lab</span>
        </div>

        <p style={{
          fontSize: 'var(--app-text-sm)', color: 'var(--app-text-muted)',
          marginBottom: 24, lineHeight: 1.5,
        }}>
          Přihlaste se pro přístup k&nbsp;operátorskému dashboardu.
        </p>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 'var(--app-text-sm)', fontWeight: 600, color: 'var(--app-text)' }}>
              Email
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoFocus
              placeholder="operator@example.cz"
              style={inputStyle}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 'var(--app-text-sm)', fontWeight: 600, color: 'var(--app-text)' }}>
              Heslo
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              style={inputStyle}
            />
          </label>

          {error && (
            <p role="alert" style={{
              fontSize: 'var(--app-text-sm)',
              color: '#9b2a14',
              background: '#fdf2f0',
              border: '1px solid #f0c4bc',
              padding: '8px 12px',
              borderRadius: 'var(--app-radius-sm)',
              margin: 0,
            }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            style={{
              marginTop: 8,
              padding: '11px 0',
              background: submitting ? 'var(--app-text-soft)' : 'var(--app-accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--app-radius-sm)',
              fontSize: 'var(--app-text-base)',
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.15s',
            }}
          >
            {submitting ? 'Přihlašuji…' : 'Přihlásit se'}
          </button>
        </form>
      </div>
    </div>
  )
}
