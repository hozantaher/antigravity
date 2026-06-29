// Vehicle VIN — module contract (binds the UI top-node to the data bottom-node).
//
//   top node      ./ui/ItemVehicle.vue — public vehicle spec table, auto-imported as <ItemVehicle>
//   contract      this file — the data types the UI binds to
//                 API surface (admin): POST /api/admin/items/decode-vin
//   bottom node   pure data structures, re-exported here as the module's contract-tagged subset
//                 of the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/{vin,vehicleStructuredData} (auto-imported via
// imports.dirs features/*/logic); server-side server/utils/{vincario,vincarioNormalize}.ts +
// server/repos/vinDecodeRepo.ts (stay under server/).
export type { VehicleSpecs, FuelType, Transmission, BodyType, DriveType, VehicleColor } from '~/models'
export type { NormalizedVin, DecodeVinResponse } from '~/models'
