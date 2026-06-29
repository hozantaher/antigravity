import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { UserRole } from '~/models'
import { db } from '~/server/utils/db'
import { createOrGetUser, grantRole, revokeRole, getById } from '~/server/repos/userRepo'

const RUN = !!process.env.POSTGRES_URL
const UID = 'itest-role-u1'

const cleanup = () => db.deleteFrom('users').where('id', '=', UID).execute()

describe.skipIf(!RUN)('userRepo roles (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await createOrGetUser({ uid: UID, email: 'itest-role@example.test', name: 'Role Tester' })
  })
  afterAll(cleanup)

  it('grants then revokes the admin role', async () => {
    expect(await grantRole(UID, UserRole.admin)).toBe(true)
    expect((await getById(UID))?.roles).toContain('admin')

    expect(await revokeRole(UID, UserRole.admin)).toBe(true)
    expect((await getById(UID))?.roles ?? []).not.toContain('admin')

    // Revoking an absent role is an idempotent no-op (still true).
    expect(await revokeRole(UID, UserRole.admin)).toBe(true)
  })
})
