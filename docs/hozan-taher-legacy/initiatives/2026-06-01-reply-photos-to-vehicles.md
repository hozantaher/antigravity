# Reply photos → vehicles (image ingestion + assignment)

- **Status:** In progress — display + capture-assign + vehicle-display shipped;
  matched-reply byte storage + backfill remain
- **Datum:** 2026-06-01
- **Trigger:** Operator — "odpovědi nestahují obrázky, je potřeba je stahovat a
  přiřazovat k vozidlům." Investigation showed images ARE downloaded but parked
  and unassigned; the pipeline is broken across several layers.

## What the data actually says (2026-06-01, PROD)

- `unmatched_inbound_attachments`: **64 image/jpeg (74 MB) + 28 image/png + 5
  PDF** — seller machine photos ARE being downloaded and stored (bytes in
  `.data` BYTEA), parked on unmatched (orphan) replies.
- `message_attachments`: **0 rows** (the Schema-B table the old serving route
  read — empty in this deployment).
- `reply_inbox.attachments_meta`: only **3 / 111** populated (matched-reply
  ingestion barely records attachments, and stores metadata only — no bytes).
- `vehicles.photos`: **0 / 14** vehicles have any photo.

So "download" half-works (unmatched path captures bytes); "assign to vehicles"
+ "display" are entirely missing.

## Operator stories → gap at each step

1. **Seller sends machine photos in a reply.** → Story: operator opens that
   reply and SEES the photos. **Serving already exists** —
   `GET /api/messages/:id/attachments/:idx` (messageAttachments.js) streams the
   bytes via a signed-ID convention (negative id → unmatched_inbound_attachments
   by `-id`; positive → message_attachments). Verified: `/api/messages/-557/
   attachments/2` serves a real 7.6 MB JPEG (200, image/jpeg). And
   `/api/replies/:id/attachments` lists the manifest. **GAP:** nothing in the v2
   UI DISPLAYS them — that's the actual missing piece for this story.
   (Correction 2026-06-01: I briefly added a duplicate
   `/api/unmatched/:id/attachments/:idx/blob` then reverted it —
   search-before-implement; the signed-ID endpoint already covers this.)
2. **Operator captures the vehicle from that reply.** → Story: the reply's
   photos attach to the new vehicle. **GAP:** `buildCreatePayload` (v2) doesn't
   include `photos`; `POST /api/vehicles` accepts a `photos` JSONB but nothing
   fills it.
3. **Operator opens the vehicle in the auction pipeline.** → Story: the photos
   show on the vehicle detail. **GAP:** `vehicles.photos` has no shape contract
   and no consumer renders it.
4. **Matched replies (reply_inbox) with photos.** → Story: same flow for a
   matched reply. **GAP:** matched-reply ingestion stores attachment *metadata*
   only (no bytes) — there is nothing to serve. Deeper fix in the Go ingest
   path (store bytes, or fetch on demand via relay /v1/imap-fetch).

## Increments

- [x] **Serving** — already existed: `GET /api/messages/:id/attachments/:idx`
  (signed-ID) + `/api/replies/:id/attachments` manifest. No new code needed.
- [x] Display inbound image thumbnails in the v2 Odpovědi conversation
  (AttachmentStrip; non-image → download chip; chat 404-on-unmatched fixed).
- [x] Capture: `buildCreatePayload(draft, reply, photos)` + `photoRefsFromAttachments`
  pull the reply's image refs → `photos` JSONB
  (`[{source:'reply',reply_id,idx,filename,content_type,url}]`); capture panel
  shows a photo preview + "Vytvořit vozidlo + N foto".
- [x] Vehicle detail renders a photo strip from `vehicle.photos[].url`.
- [x] Matched-reply byte storage (Go ingest) — migration 144 added
  `reply_inbox_attachments`; insertReplyInbox now persists attachment bytes;
  the dashboard serves them via the positive-id branch. Applies to replies
  ingested AFTER the orchestrator deploy (historical matched replies kept only
  metadata — bytes are gone).
- [ ] Backfill: link the 92 already-parked unmatched images to vehicles where a
  vehicle was captured from that reply (one-time).

## Cross-refs

- Subsystem map: [imap-inbound](../subsystem-maps/imap-inbound.md) (attachment
  parking in `parkUnattributed`).
- Memory: `project_vehicle_auction_intake` ("leady JSOU vozidla" — photos are
  core auction-readiness, not price).
- Serving safety mirrors `src/server-routes/attachments.js`.
