# Messaging (module)
![Version](https://img.shields.io/badge/version-v1.1.0-blue)


Vertical-axis module — public Q&A on a listing. A signed-in user asks a question on an item detail
page; an admin answers it from the item editor; the published thread renders on the listing under
the bid history. Mirrors `bidding` structurally (per-item, user-authored, time-ordered, admin-visible
record) and `contact_messages` operationally (durable row, rate-limited public ingest, admin surface,
best-effort ops email).

- **Top node (UX/UI):** `ui/QuestionThread.vue`, `ui/QuestionRow.vue`, `ui/QuestionForm.vue` (auto-imported as `<QuestionThread>`, `<QuestionRow>`, `<QuestionForm>`).
- **Contract:** `contract.ts` — the `Question`/`QuestionStatus` types the UI + logic bind to, re-exported from the central `models/` barrel (decision §7.2). Ask API: `POST /api/item/[id]/question`. Public list: `GET /api/item/[id]/questions` (published only). Admin: `POST /api/admin/item/[id]/question`, `GET /api/admin/questions`.
- **Bottom node:** the `Question` model — not physically moved (decision §7.2).
- **Behind the contract (swappable impl):** `logic/useItemQuestions.ts` (public in-memory pagination + `ask`) + `logic/useAdminQuestions.ts` (admin moderation state); server-side moderation + persistence in `server/repos/questionRepo.ts` and the question handlers stay under `server/`.

**Moderation:** new questions land `status='pending'` and are excluded from the public list and the
embedded item-detail payload. They become public only when an admin publishes them (answering
auto-publishes). This keeps unmoderated user text off the crawler-indexed SEO page.

Self-measure: `pnpm module:signal messaging`.
