#!/usr/bin/env tsx
// Promote a real (already-signed-in) user to admin by email.
// Usage: pnpm grant:admin <email>
import { loadEnv } from './load-env'
import { UserRole } from '../models'

loadEnv()
// Batch work: opt out of the request-path statement timeout.
process.env.POSTGRES_STATEMENT_TIMEOUT ??= '0'

const main = async () => {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: pnpm grant:admin <email>')
    process.exitCode = 1
    return
  }

  // Dynamic import after loadEnv() so db.ts reads POSTGRES_URL from the loaded env.
  const { getByEmail, grantRole } = await import('../server/repos/userRepo')
  const { destroyDb } = await import('../server/utils/db')
  try {
    const user = await getByEmail(email)
    if (!user) {
      console.error(`No user with email ${email}. Have them sign in once first, then re-run.`)
      process.exitCode = 1
      return
    }
    if (user.roles.includes(UserRole.admin)) {
      console.log(`${user.email} is already an admin.`)
      return
    }
    await grantRole(user.id, UserRole.admin)
    console.log(`Granted admin to ${user.email}.`)
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    await destroyDb()
  }
}

main()
