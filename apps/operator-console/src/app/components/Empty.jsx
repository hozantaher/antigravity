import { Link } from 'react-router-dom'
import { SearchX, Inbox } from 'lucide-react'

// Shared calm empty state — a soft icon, a serif title, a one-line hint, and an
// optional recovery action. Replaces bare floating text so every "nothing here"
// reads as intentional, not broken. Per the UX-craft bar (calm empty states,
// never a false 0).
//
// action: { to } (Link) or { onClick } (button) + label.
export default function Empty({ icon: Icon = Inbox, title, hint, action, testid }) {
  return (
    <div className="app-empty" data-testid={testid}>
      <span className="app-empty__icon"><Icon size={26} strokeWidth={1.75} /></span>
      <div className="app-empty__title">{title}</div>
      {hint ? <div className="app-empty__hint">{hint}</div> : null}
      {action ? (
        action.to
          ? <Link to={action.to} className="app-empty__action">{action.label}</Link>
          : <button type="button" className="app-empty__action" onClick={action.onClick}>{action.label}</button>
      ) : null}
    </div>
  )
}

// Convenience: the "no search/filter results" variant.
export function EmptySearch(props) {
  return <Empty icon={SearchX} {...props} />
}
