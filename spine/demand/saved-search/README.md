# Saved Search (module)

Vertical-axis module — a signed-in user saves a named search (the exact `SearchQuery` they were
browsing with), manages the list from their profile, and opts into a weekly email alert. A cron
re-runs each due query through the existing `itemRepo` filter pipeline and emails the owner the newest
matches, with a one-click HMAC unsubscribe. Mirrors `bidding` structurally and reuses the
`newsletter-email` send pipeline (the query is user-authored and per-search, not algorithmic per-user).

- **Top node (UX/UI):** `ui/SavedSearchCard.vue`, `ui/SaveSearchButton.vue` (auto-imported as `<SavedSearchCard>`, `<SaveSearchButton>`); the page-local `pages/profile/ui/SavedSearches.vue` panel renders the list. `<SaveSearchButton>` sits on the search results page.
- **Contract:** `contract.ts` — the `SavedSearch` type the UI + logic bind to, re-exported from the central `models/` barrel (decision §7.2). Its `query` field **is** a `SearchQuery` (reused, not redefined). CRUD API: `GET`/`POST /api/saved-searches`, `PATCH`/`DELETE /api/saved-searches/[id]`. Alert cron: `POST /api/cron/saved-search-alerts`. Unsubscribe: `GET /api/saved-search/unsubscribe?token=…`.
- **Bottom node:** the `SavedSearch` model — not physically moved (decision §7.2). `lastAlertedAt` is server-only (the CAS column) and not on the model.
- **Behind the contract (swappable impl):** `logic/useSavedSearches.ts` (list + create/delete/toggle) + `logic/useSaveCurrentSearch.ts` (save the current search). Server-side owner-scoped CRUD + per-search claim-CAS in `server/repos/savedSearchRepo.ts`, the alert orchestrator in `server/utils/savedSearchAlerts.ts` (reuses `enqueueEmail` + the `server/email` render/send stack + the HMAC unsubscribe construction), and the API handlers stay under `server/`.

**Reuse, not duplication:** the alert query runs through `itemRepo.listSavedSearchMatchesPage` (the same `applyItemFilter` + default ordering as `/api/search`, forced `sold:false`/`hidden:false`); the digest renders through the existing `savedSearchAlert` template key + 12 server-side translation blocks; delivery + dedup ride `enqueueEmail`; the unsubscribe HMAC reuses `hashApiToken` + `INTERNAL_API_SECRET`.

Self-measure: `pnpm module:signal saved-search`.
