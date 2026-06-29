import { useState } from 'react'
import { Paperclip } from 'lucide-react'
import { useResource } from '../../hooks/useResource'

// Odpovědi — inbound attachment strip. Sellers send machine photos in their
// replies; this finally SHOWS them. Reads the manifest from
// /api/replies/:id/attachments and renders image/* as thumbnails streamed from
// /api/messages/:id/attachments/:idx (signed-ID: negative → unmatched_inbound
// where the bytes live; positive → message_attachments). Non-images become a
// download chip. A thumbnail that fails to load (matched reply whose bytes
// aren't stored) falls back to a filename chip — never a broken-image icon.
// Foundation for assigning these photos to the vehicle (next increment).

function Thumb({ url, filename }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <a href={url} target="_blank" rel="noreferrer" className="app-attstrip__file" data-testid="app-att-file"><Paperclip size={14} className="app-ico" aria-hidden="true" /> {filename}</a>
  return (
    <a href={url} target="_blank" rel="noreferrer" className="app-attstrip__thumb" data-testid="app-att-thumb" title={filename}>
      <img src={url} alt={filename} loading="lazy" onError={() => setFailed(true)} />
    </a>
  )
}

export default function AttachmentStrip({ replyId }) {
  const att = useResource(replyId != null ? `/api/replies/${replyId}/attachments` : null, { enabled: replyId != null })
  const items = att.data?.attachments || []
  // Distinguish a load FAILURE from genuinely-empty: on error show a small
  // notice instead of returning null (which looks identical to "no attachments"),
  // so the operator doesn't silently miss seller photos that failed to load.
  if (att.status === 'error') {
    return (
      <div className="app-attstrip" data-testid="app-attachments">
        <div className="app-attstrip__label">Přílohy se nepodařilo načíst</div>
      </div>
    )
  }
  if (items.length === 0) return null
  return (
    <div className="app-attstrip" data-testid="app-attachments">
      <div className="app-attstrip__label">Přílohy ({items.length})</div>
      <div className="app-attstrip__items">
        {items.map((a) => {
          const url = `/api/messages/${replyId}/attachments/${a.idx}`
          const isImg = String(a.content_type || '').startsWith('image/')
          return isImg
            ? <Thumb key={a.idx} url={url} filename={a.filename} />
            : <a key={a.idx} href={url} target="_blank" rel="noreferrer" className="app-attstrip__file" data-testid="app-att-file"><Paperclip size={14} className="app-ico" aria-hidden="true" /> {a.filename}</a>
        })}
      </div>
    </div>
  )
}
