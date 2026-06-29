import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdminCategoryLabel } from '~/features/platform/admin/logic/useAdminCategoryLabel'
import useExternalTranslate from '~/features/platform/admin/logic/useExternalTranslate'
import { useImageUpload } from '~/features/supply/media-upload/logic/useImageUpload'

beforeEach(() => vi.clearAllMocks())

describe('useAdminCategoryLabel', () => {
  it('maps known ids and falls back to the title', () => {
    const { categoryLabel } = useAdminCategoryLabel()
    expect(categoryLabel({ id: 'car' } as never)).toBe('Cars')
    expect(categoryLabel({ id: 'xyz', title: 'Custom' } as never)).toBe('Custom')
  })
})

describe('useExternalTranslate', () => {
  it('translates a single string', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ texts: ['Ahoj'] }))
    expect(await useExternalTranslate().translateDeepl('Hi', 'cz')).toEqual([{ text: 'Ahoj' }])
  })

  it('translates an array in one batched request', async () => {
    const f = vi.fn().mockResolvedValue({ texts: ['A', 'B'] })
    vi.stubGlobal('$fetch', f)
    expect(await useExternalTranslate().translateDeepl(['x', 'y'], 'en')).toEqual([{ text: 'A' }, { text: 'B' }])
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]![1].body).toMatchObject({ text: ['x', 'y'], code: 'en' })
  })
})

describe('useImageUpload', () => {
  it('uploads a file as multipart and returns the url', async () => {
    const f = vi.fn().mockResolvedValue({ url: 'https://cdn/x' })
    vi.stubGlobal('$fetch', f)
    const up = useImageUpload()
    const url = await up.execute(new File(['x'], 'a.jpg', { type: 'image/jpeg' }), 'item1')
    expect(url).toBe('https://cdn/x')
    expect(up.pending.value).toBe(false)
    const [path, opts] = f.mock.calls[0]!
    expect(path).toBe('/api/admin/uploads')
    expect(opts.method).toBe('POST')
    expect(opts.body).toBeInstanceOf(FormData)
  })

  it('captures an error and returns null', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ data: { statusMessage: 'too big' } }))
    const up = useImageUpload()
    expect(await up.execute(new File(['x'], 'a.jpg'), 'item1')).toBeNull()
    expect(up.error.value).toBe('too big')
  })
})
