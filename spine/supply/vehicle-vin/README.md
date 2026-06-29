# Vehicle VIN (module)
![Version](https://img.shields.io/badge/version-v1.3.3-blue)


Vertical-axis module — see `plan.md` §2.

- **Top node (UX/UI):** `ui/ItemVehicle.vue` (public vehicle spec table; auto-imported as `<ItemVehicle>`).
- **Contract:** `contract.ts` — `VehicleSpecs` + enum types (`FuelType`, `Transmission`, `BodyType`, `DriveType`, `VehicleColor`) and `NormalizedVin`/`DecodeVinResponse`, re-exported from the `models/` barrel (§7.2). Admin decode API: `POST /api/admin/items/decode-vin`.
- **Bottom node:** those model types — not physically moved (§7.2).
- **Behind the contract:** `logic/{vin,vehicleStructuredData}.ts` (auto-imported via `imports.dirs: features/*/logic`); server-side `server/utils/{vincario,vincarioNormalize}.ts` + `server/repos/vinDecodeRepo.ts` stay under `server/`.

> Admin editor (`pages/admin/item/components/ItemDetailVehicle.vue`, `composables/admin/useAdminItemVinDecode.ts`) is admin-namespaced — migrates with the admin module (P6).

Self-measure: `pnpm module:signal vehicle-vin`.
