// Media Upload — module contract (binds the UI top-node to the data bottom-node).
//
//   top node      ./ui/Pano.vue — 360° still renderer, auto-imported as <Pano>
//   contract      this file — media-upload binds to plain image URL strings; there is no
//                 dedicated model type (images are `string[]` on Item). The contract is the
//                 upload API surface + the image-processing URL shape:
//                   API surface (admin): POST /api/admin/uploads
//                   image-processing URLs: tokenized firebasestorage…?alt=media&token= URLs
//                     transformed via the image-processing extension
//   bottom node   none — no model type; the binding value is a `string` (image URL)
//
// Behind the contract (swappable impl): logic/{useImageUpload,useImageProcessing} (auto-imported
// via imports.dirs features/*/logic); server-side server/repos/uploadRepo.ts +
// server/utils/uploadValidation.ts (stay under server/).
export {}
