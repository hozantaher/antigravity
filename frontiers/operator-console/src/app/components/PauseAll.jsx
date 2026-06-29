import { useState } from 'react'
import { CirclePause } from 'lucide-react'
import { useToast } from '../../components/Toast'

// topbar Emergency Pause-All (S6 shell-parity). Halts every running campaign
// from any page — the operator's global kill switch. Request shape is verbatim
// from the Layout handler (POST /api/campaigns/pause-all, JSON body) so the
// BFF behaviour is identical; the window.confirm is the operator gate.
export default function PauseAll() {
  const toast = useToast()
  const [loading, setLoading] = useState(false)

  const onClick = async () => {
    if (loading) return
    if (!window.confirm('Nouzové zastavení: pozastavit VŠECHNY běžící kampaně?\n\nVrátí se ručním spuštěním jednotlivých kampaní.')) return
    setLoading(true)
    try {
      const r = await fetch('/api/campaigns/pause-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json().catch(() => ({}))
      toast(`Nouzové zastavení: pozastaveno ${d.count ?? 0} kampaní`, 'ok')
    } catch (e) {
      toast(`Chyba při zastavení: ${e.message || 'zkus to znovu'}`, 'err')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button type="button" className="app-pause-all" onClick={onClick} disabled={loading}
      data-testid="app-pause-all" title="Nouzové zastavení všech běžících kampaní">
      <CirclePause size={14} strokeWidth={2} />
      {loading ? 'Zastavuji…' : 'Pauza vše'}
    </button>
  )
}
