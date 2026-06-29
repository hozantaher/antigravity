import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import deleteUserH from '~/server/api/admin/user/[id]/index.delete'
import resetPwH from '~/server/api/admin/user/[id]/reset-password.post'
import roleH from '~/server/api/admin/user/[id]/role.post'
import { getById, softDeleteUser, grantRole, revokeRole } from '~/server/repos/userRepo'
import { writeAudit } from '~/server/repos/auditRepo'
import { enqueueEmail } from '~/server/utils/emailQueue'

vi.mock('~/server/repos/userRepo', () => ({
  getById: vi.fn(),
  softDeleteUser: vi.fn(),
  grantRole: vi.fn(),
  revokeRole: vi.fn(),
}))
vi.mock('~/server/repos/auditRepo', () => ({ writeAudit: vi.fn() }))
vi.mock('~/server/utils/emailQueue', () => ({ enqueueEmail: vi.fn() }))

// Firebase Admin needs real credentials to init — mock it so getAuthAdmin() returns stub methods.
const fbDeleteUser = vi.fn()
const fbResetLink = vi.fn()
vi.mock('~/server/utils/firebase', () => ({
  getAuthAdmin: () => ({ deleteUser: fbDeleteUser, generatePasswordResetLink: fbResetLink }),
}))

const g = globalThis as unknown as { requireInteractiveAdmin: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  g.requireInteractiveAdmin.mockResolvedValue({ id: 'admin1' } as never)
  fbResetLink.mockResolvedValue('https://reset.link')
})

describe('admin user delete', () => {
  it('soft-deletes the row, removes the Firebase identity, and audits', async () => {
    vi.mocked(getById).mockResolvedValue({ id: 'u1', email: 'u@e.test', fullName: 'U' } as never)
    expect(await deleteUserH(makeEvent({ params: { id: 'u1' } }) as never)).toEqual({ ok: true })
    expect(softDeleteUser).toHaveBeenCalledWith('u1')
    expect(fbDeleteUser).toHaveBeenCalledWith('u1')
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.delete', entityId: 'u1' }))
  })

  it('still succeeds (DB anonymized) when the Firebase delete fails', async () => {
    vi.mocked(getById).mockResolvedValue({ id: 'u1', email: 'u@e.test', fullName: 'U' } as never)
    fbDeleteUser.mockRejectedValueOnce(new Error('firebase down'))
    expect(await deleteUserH(makeEvent({ params: { id: 'u1' } }) as never)).toEqual({ ok: true })
    expect(softDeleteUser).toHaveBeenCalledWith('u1')
  })

  it('refuses self-delete (400)', async () => {
    await expect(deleteUserH(makeEvent({ params: { id: 'admin1' } }) as never)).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(softDeleteUser).not.toHaveBeenCalled()
  })

  it('404 when the user does not exist', async () => {
    vi.mocked(getById).mockResolvedValue(undefined as never)
    await expect(deleteUserH(makeEvent({ params: { id: 'ghost' } }) as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})

describe('admin user reset-password', () => {
  it('generates a Firebase reset link and enqueues the localized email', async () => {
    vi.mocked(getById).mockResolvedValue({ id: 'u1', email: 'u@e.test', language: { code: 'cz' } } as never)
    expect(await resetPwH(makeEvent({ params: { id: 'u1' } }) as never)).toEqual({ ok: true })
    expect(fbResetLink).toHaveBeenCalledWith('u@e.test')
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: 'u@e.test',
        templateKey: 'resetPassword',
        language: 'cz',
        params: { resetUrl: 'https://reset.link' },
      }),
    )
  })

  it('404 when the user is missing', async () => {
    vi.mocked(getById).mockResolvedValue(undefined as never)
    await expect(resetPwH(makeEvent({ params: { id: 'x' } }) as never)).rejects.toMatchObject({ statusCode: 404 })
    expect(enqueueEmail).not.toHaveBeenCalled()
  })
})

describe('admin user role', () => {
  it('grants admin and audits', async () => {
    vi.mocked(grantRole).mockResolvedValue(true as never)
    vi.mocked(getById).mockResolvedValue({ id: 'u1', roles: ['user', 'admin'] } as never)
    await roleH(makeEvent({ params: { id: 'u1' }, body: { grant: true } }) as never)
    expect(grantRole).toHaveBeenCalledWith('u1', 'admin')
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.grantAdmin' }))
  })

  it('revokes admin', async () => {
    vi.mocked(revokeRole).mockResolvedValue(true as never)
    vi.mocked(getById).mockResolvedValue({ id: 'u1', roles: ['user'] } as never)
    await roleH(makeEvent({ params: { id: 'u1' }, body: { grant: false } }) as never)
    expect(revokeRole).toHaveBeenCalledWith('u1', 'admin')
  })

  it('refuses self-revoke (400)', async () => {
    await expect(roleH(makeEvent({ params: { id: 'admin1' }, body: { grant: false } }) as never)).rejects.toMatchObject(
      { statusCode: 400 },
    )
    expect(revokeRole).not.toHaveBeenCalled()
  })

  it('404 when the user does not exist', async () => {
    vi.mocked(grantRole).mockResolvedValue(false as never)
    await expect(roleH(makeEvent({ params: { id: 'ghost' }, body: { grant: true } }) as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
