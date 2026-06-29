// Recommendation — module contract (binds the UI top-node to the serving/ingest surface).
//
//   top node      ./ui/SimilarItems.vue, ./ui/RecommendedItems.vue, ./ui/ItemsRail.vue —
//        │        auto-imported as <SimilarItems>, <RecommendedItems>, <ItemsRail> (shared rail)
//   contract      this file — the event/serving data types the UI + logic bind to
//        │        serving API: GET /api/recommendations/{home,item}
//        │        ingest API:  POST /api/track
//   bottom node   pure Recommendation model types, re-exported here as the module's
//                 contract-tagged subset of the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/{useTracking,useDetailTracking} (auto-imported via
// imports.dirs features/*/logic); server-side server/utils/recommendation/* +
// server/repos/recommendationRepo.ts (stay under server/).
export type { TrackEvent, TrackEventMeta, RecoEventType, RecoSurface } from '~/models'
