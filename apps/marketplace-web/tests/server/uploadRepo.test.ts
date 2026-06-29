import { beforeEach, describe, expect, it, vi } from 'vitest'

import { uploadAdImage } from '~/server/repos/uploadRepo'
import { getStorageBucket } from '~/server/utils/firebase'

vi.mock('~/server/utils/firebase', () => ({ getStorageBucket: vi.fn() }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn() }))

const save = vi.fn()
const bucket = { name: 'garaaage.appspot', file: vi.fn(() => ({ save })) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getStorageBucket).mockReturnValue(bucket as never)
  save.mockResolvedValue(undefined)
})

describe('uploadAdImage', () => {
  it('rejects validation failures before touching storage', async () => {
    const res = await uploadAdImage({ itemId: '../x', contentType: 'image/jpeg', buffer: Buffer.from('x') })
    expect(res).toEqual({ ok: false, error: 'invalid_item_id' })
    expect(getStorageBucket).not.toHaveBeenCalled()
  })

  it('saves with a download token and returns a tokened URL', async () => {
    const res = await uploadAdImage({ itemId: 'item1', contentType: 'image/jpeg', buffer: Buffer.from('img') })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.objectPath).toMatch(/^public\/ads\/item1\/.+\.jpg$/)
      expect(res.url).toContain('firebasestorage.googleapis.com')
      expect(res.url).toContain('alt=media&token=')
    }
    expect(save).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ resumable: false, contentType: 'image/jpeg' }),
    )
  })

  it('maps a storage failure to storage_unavailable', async () => {
    save.mockRejectedValue(new Error('bucket down'))
    const res = await uploadAdImage({ itemId: 'item1', contentType: 'image/png', buffer: Buffer.from('img') })
    expect(res).toEqual({ ok: false, error: 'storage_unavailable' })
  })
})
