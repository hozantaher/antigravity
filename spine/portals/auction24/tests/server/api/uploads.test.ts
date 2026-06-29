import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/admin/uploads.post'
import { requireAdmin } from '~/server/utils/session'
import { uploadAdImage } from '~/server/repos/uploadRepo'

vi.mock('~/server/utils/session', () => ({ requireAdmin: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/repos/uploadRepo', () => ({ uploadAdImage: vi.fn() }))

const filePart = { name: 'file', filename: 'a.jpg', data: Buffer.from('img'), type: 'image/jpeg' }
const itemIdPart = { name: 'itemId', data: Buffer.from('item1') }

const stubParts = (parts: unknown[]) => vi.stubGlobal('readMultipartFormData', vi.fn().mockResolvedValue(parts))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAdmin).mockResolvedValue({ id: 'a1' } as never)
})

describe('POST /api/admin/uploads', () => {
  it('400s when the file part is missing', async () => {
    stubParts([itemIdPart])
    await expect(handler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('400s when the itemId is missing', async () => {
    stubParts([filePart])
    await expect(handler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('uploads and returns the url + object path', async () => {
    stubParts([filePart, itemIdPart])
    vi.mocked(uploadAdImage).mockResolvedValue({
      ok: true,
      url: 'https://cdn/x',
      objectPath: 'public/ads/item1/x.jpg',
    } as never)
    const res = await handler(makeEvent() as never)
    expect(uploadAdImage).toHaveBeenCalledWith({ itemId: 'item1', contentType: 'image/jpeg', buffer: filePart.data })
    expect(res).toEqual({ url: 'https://cdn/x', objectPath: 'public/ads/item1/x.jpg' })
  })

  it.each([
    ['unsupported_content_type', 415],
    ['file_too_large', 413],
    ['storage_unavailable', 503],
    ['invalid_item_id', 400],
    ['empty_file', 400],
  ])('maps the %s repo error to %d', async (error, status) => {
    stubParts([filePart, itemIdPart])
    vi.mocked(uploadAdImage).mockResolvedValue({ ok: false, error } as never)
    await expect(handler(makeEvent() as never)).rejects.toMatchObject({ statusCode: status })
  })
})
