# Recommendation (module)
![Version](https://img.shields.io/badge/version-v1.1.0-blue)


Vertical-axis module — see `plan.md` §2.

- **Top node (UX/UI):** `ui/SimilarItems.vue`, `ui/RecommendedItems.vue`, `ui/ItemsRail.vue` (auto-imported as `<SimilarItems>`, `<RecommendedItems>`, `<ItemsRail>`). `ItemsRail` is the shared rail used by both `RecommendedItems` (homepage "Vybráno pro vás") and `SimilarItems` (detail "Podobné inzeráty").
- **Contract:** `contract.ts` — the event/serving data types the UI + logic bind to (`TrackEvent`, `TrackEventMeta`, `RecoEventType`, `RecoSurface`), re-exported from the central `models/` barrel (decision §7.2). Serving API: `GET /api/recommendations/{home,item}`. Ingest API: `POST /api/track`.
- **Bottom node:** the `Recommendation` model — not physically moved (decision §7.2).
- **Behind the contract (swappable impl):** `logic/useTracking.ts` + `logic/useDetailTracking.ts` (auto-imported via `imports.dirs: features/*/logic`); server-side `server/utils/recommendation/{build,pool,serve}.ts` + `server/repos/recommendationRepo.ts` stay under `server/`.

Self-measure: `pnpm module:signal recommendation`.
