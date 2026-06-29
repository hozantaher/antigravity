import { describe, expect, it } from 'vitest'
import { buildImageUrl, prepareStorageUrl } from '~/utils/imageUrl'

const FB = 'https://firebasestorage.googleapis.com/v0/b/bucket.appspot.com/o/'

describe('prepareStorageUrl', () => {
  it('returns empty string for falsy url', () => {
    expect(prepareStorageUrl('')).toBe('')
  })

  it('leaves non-firebasestorage urls untouched', () => {
    expect(prepareStorageUrl('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg')
  })

  it('returns the url unchanged when the firebasestorage shape does not match', () => {
    // host substring present but path shape invalid (no /v0/b/.../o/)
    const weird = 'https://firebasestorage.googleapis.com/other'
    expect(prepareStorageUrl(weird)).toBe(weird)
  })

  it('double-encodes the object path and keeps an existing alt=media query', () => {
    const url = `${FB}ads%2F1%2Fpic.jpg?alt=media&token=abc`
    expect(prepareStorageUrl(url)).toBe(`${FB}ads%252F1%252Fpic.jpg?alt=media&token=abc`)
  })

  it('defaults to ?alt=media when no query is present', () => {
    const url = `${FB}ads%2F1%2Fpic.jpg`
    expect(prepareStorageUrl(url)).toBe(`${FB}ads%252F1%252Fpic.jpg?alt=media`)
  })

  it('appends &alt=media when a query exists without alt=media', () => {
    const url = `${FB}ads%2F1%2Fpic.jpg?token=abc`
    expect(prepareStorageUrl(url)).toBe(`${FB}ads%252F1%252Fpic.jpg?token=abc&alt=media`)
  })
})

describe('buildImageUrl', () => {
  const endpoint = 'https://img.example.com'
  const source = 'https://cdn.example.com/photo.jpg'

  const parseOps = (built: string): Array<Record<string, unknown>> => {
    const raw = built.split('operations=')[1]!
    return JSON.parse(decodeURIComponent(raw)) as Array<Record<string, unknown>>
  }

  it('returns the source unchanged when endpoint is missing', () => {
    expect(buildImageUrl('', source)).toBe(source)
  })

  it('returns the source unchanged when source is missing', () => {
    expect(buildImageUrl(endpoint, '')).toBe('')
  })

  it('returns the source unchanged when source is not http', () => {
    expect(buildImageUrl(endpoint, 'ftp://x/y.jpg')).toBe('ftp://x/y.jpg')
  })

  it('builds input+output operations with default format and quality', () => {
    const built = buildImageUrl(endpoint, source)
    expect(built.startsWith(`${endpoint}/process?operations=`)).toBe(true)
    const ops = parseOps(built)
    expect(ops).toEqual([
      { operation: 'input', type: 'url', url: source },
      { operation: 'output', format: 'webp', quality: 85 },
    ])
  })

  it('adds a resize operation when width is provided', () => {
    const ops = parseOps(buildImageUrl(endpoint, source, { width: 400 }))
    expect(ops[1]).toEqual({
      operation: 'resize',
      width: 400,
      height: undefined,
      fit: 'cover',
      withoutEnlargement: true,
    })
  })

  it('adds a resize operation when only height is provided', () => {
    const ops = parseOps(buildImageUrl(endpoint, source, { height: 300 }))
    expect(ops[1]).toMatchObject({ operation: 'resize', height: 300 })
  })

  it('honours explicit format and quality options', () => {
    const ops = parseOps(buildImageUrl(endpoint, source, { format: 'jpeg', quality: 60 }))
    expect(ops.at(-1)).toEqual({ operation: 'output', format: 'jpeg', quality: 60 })
  })

  it('runs firebasestorage sources through prepareStorageUrl', () => {
    const src = `${FB}ads%2F1%2Fpic.jpg?alt=media&token=t`
    const ops = parseOps(buildImageUrl(endpoint, src))
    expect(ops[0]!.url).toBe(`${FB}ads%252F1%252Fpic.jpg?alt=media&token=t`)
  })
})
