import { promises as fs } from 'fs'
import { resolve } from 'path'
import { Migrator, FileMigrationProvider } from 'kysely/migration'
import { db } from './db'

const migrationsFolder = resolve(process.cwd(), 'server/migrations')

export const createMigrator = (): Migrator =>
  new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path: { join: (...parts: string[]) => resolve(...parts) },
      migrationFolder: migrationsFolder,
    }),
  })

export const migrateUp = async (): Promise<void> => {
  const migrator = createMigrator()
  const { error, results } = await migrator.migrateToLatest()

  for (const r of results ?? []) {
    if (r.status === 'Success') console.log(`✓ migration "${r.migrationName}" applied`)
    else if (r.status === 'Error') console.error(`✗ migration "${r.migrationName}" failed`)
  }

  if (error) {
    console.error('Migration runner error:', error)
    throw error
  }
}

export const migrateDown = async (): Promise<void> => {
  const migrator = createMigrator()
  const { error, results } = await migrator.migrateDown()

  for (const r of results ?? []) {
    if (r.status === 'Success') console.log(`✓ migration "${r.migrationName}" rolled back`)
    else if (r.status === 'Error') console.error(`✗ migration "${r.migrationName}" rollback failed`)
  }

  if (error) {
    console.error('Rollback error:', error)
    throw error
  }
}

export const migrateStatus = async (): Promise<void> => {
  const migrator = createMigrator()
  const migrations = await migrator.getMigrations()
  if (migrations.length === 0) {
    console.log('No migrations defined.')
    return
  }
  for (const m of migrations) {
    const mark = m.executedAt ? '✓' : ' '
    const at = m.executedAt ? new Date(m.executedAt).toISOString() : 'pending'
    console.log(`[${mark}] ${m.name}  (${at})`)
  }
}
