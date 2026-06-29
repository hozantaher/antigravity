import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { escapeLike, unaccentLikeAny } from '~/server/utils/search'

describe('escapeLike', () => {
  it.each([
    ['50%', '50\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
    ['%_\\', '\\%\\_\\\\'],
    ['clean', 'clean'],
  ])('escapes LIKE wildcards in %s', (input, expected) => {
    expect(escapeLike(input)).toBe(expected)
  })
})

describe('unaccentLikeAny', () => {
  it('returns one predicate per target', () => {
    const preds = unaccentLikeAny([sql`title`, sql`location`], 'audi')
    expect(preds).toHaveLength(2)
  })
  it('returns no predicates for no targets', () => {
    expect(unaccentLikeAny([], 'audi')).toHaveLength(0)
  })
})
