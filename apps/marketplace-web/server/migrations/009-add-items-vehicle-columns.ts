import type { Kysely } from 'kysely'

// Vehicle parameters from VIN decode (Vincario). The enum-ish fields are plain text (no CHECK —
// the app normalizes them onto fixed enums); make/model/year + the long tail live in `specs` JSONB.
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('items')
    .addColumn('vin', 'text')
    .addColumn('fuel_type', 'text')
    .addColumn('transmission', 'text')
    .addColumn('body_type', 'text')
    .addColumn('drive_type', 'text')
    .addColumn('engine_power_kw', 'integer')
    .addColumn('engine_displacement_ccm', 'integer')
    .addColumn('color', 'text')
    .addColumn('first_registration_date', 'text')
    .addColumn('specs', 'jsonb')
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('items')
    .dropColumn('vin')
    .dropColumn('fuel_type')
    .dropColumn('transmission')
    .dropColumn('body_type')
    .dropColumn('drive_type')
    .dropColumn('engine_power_kw')
    .dropColumn('engine_displacement_ccm')
    .dropColumn('color')
    .dropColumn('first_registration_date')
    .dropColumn('specs')
    .execute()
}
