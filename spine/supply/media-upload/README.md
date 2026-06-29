# Media Upload (module)

Vertical-axis module — see `plan.md` §2.

- **Top node (UX/UI):** `ui/Pano.vue` — 360° still renderer (auto-imported as `<Pano>`). `ItemGallery`/`ItemLightbox` live in their owning domain, not here.
- **Contract:** media-upload binds to plain image URL strings (no dedicated model type — images are `string[]` on `Item`). The contract is the upload API `POST /api/admin/uploads` plus image-processing URLs consumed via `composables` (`getCardImage`/`getMediumImage`/`getLargeImage`/`imgUrl`).
- **Behind the contract:** `logic/{useImageUpload,useImageProcessing}.ts` (auto-imported via `imports.dirs: features/*/logic`); server-side `server/repos/uploadRepo.ts` + `server/utils/uploadValidation.ts` stay under `server/`.

Self-measure: `pnpm module:signal media-upload`.
