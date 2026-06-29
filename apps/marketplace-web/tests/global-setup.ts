// Integration project only: migrate the test DB once before the suite, and
// close the pool after. No-ops when POSTGRES_URL is unset.
export const setup = async (): Promise<void> => {
  if (!process.env.POSTGRES_URL) return
  const { migrateUp } = await import('../server/utils/migrate')
  await migrateUp()
}

export const teardown = async (): Promise<void> => {
  const { destroyDb } = await import('../server/utils/db')
  await destroyDb().catch(() => {})
}
