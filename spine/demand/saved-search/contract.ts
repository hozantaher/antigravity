// Saved Search — module contract (binds the management UI to the saved-search surface).
//
//   top node      ./ui/SavedSearchCard.vue, ./ui/SaveSearchButton.vue —
//        │        auto-imported as <SavedSearchCard>, <SaveSearchButton>; the page-local
//        │        features/demand/saved-search/ui/SavedSearches.vue panel composes the list
//   contract      this file — the SavedSearch data type the UI + logic bind to
//        │        CRUD API: GET/POST /api/saved-searches, PATCH/DELETE /api/saved-searches/[id]
//        │        cron:     POST /api/cron/saved-search-alerts (CRON_SECRET, machine-to-machine)
//        │        unsub:    GET  /api/saved-search/unsubscribe?token=… (HMAC, no auth)
//   bottom node   the pure SavedSearch model — its `query` field IS a SearchQuery (reused, not
//                 redefined) — re-exported here from the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/{useSavedSearches,useSaveCurrentSearch} (auto-imported
// via imports.dirs features/*/logic); savedSearchRepo + savedSearchAlerts (claim-CAS + the reused
// newsletter email pipeline) stay under server/.
export type { SavedSearch, SearchQuery } from '~/models'
