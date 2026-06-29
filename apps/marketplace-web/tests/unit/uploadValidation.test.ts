import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_SIZE_BYTES, buildUploadObjectPath, validateImageUpload } from '~/server/utils/uploadValidation'

describe('validateImageUpload', () => {
  it('rejects an itemId that could escape the upload prefix', () => {
    expect(validateImageUpload('../etc', 'image/jpeg', 100)).toEqual({ ok: false, error: 'invalid_item_id' })
    expect(validateImageUpload('a/b', 'image/jpeg', 100)).toEqual({ ok: false, error: 'invalid_item_id' })
  })

  it('rejects an unsupported content type', () => {
    expect(validateImageUpload('item1', 'image/svg+xml', 100)).toEqual({ ok: false, error: 'unsupported_content_type' })
    expect(validateImageUpload('item1', 'application/pdf', 100)).toEqual({
      ok: false,
      error: 'unsupported_content_type',
    })
  })

  it.each([[0], [-1], [NaN]])('rejects an empty/invalid size %s', size => {
    expect(validateImageUpload('item1', 'image/jpeg', size)).toEqual({ ok: false, error: 'empty_file' })
  })

  it('rejects a file over the size cap', () => {
    expect(validateImageUpload('item1', 'image/jpeg', MAX_IMAGE_SIZE_BYTES + 1)).toEqual({
      ok: false,
      error: 'file_too_large',
    })
  })

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/avif', 'avif'],
    ['image/gif', 'gif'],
  ])('accepts %s and maps the extension to %s', (contentType, ext) => {
    expect(validateImageUpload('item-1_x', contentType, 1024)).toEqual({ ok: true, ext })
  })
})

describe('buildUploadObjectPath', () => {
  it('groups under public/ads/{itemId}/ with a random uuid name', () => {
    expect(buildUploadObjectPath('item1', 'jpg')).toMatch(/^public\/ads\/item1\/[0-9a-f-]{36}\.jpg$/)
  })
  it('produces a unique name each call', () => {
    expect(buildUploadObjectPath('item1', 'png')).not.toBe(buildUploadObjectPath('item1', 'png'))
  })
  it('guards the itemId independently', () => {
    expect(() => buildUploadObjectPath('../escape', 'jpg')).toThrow()
  })
})
