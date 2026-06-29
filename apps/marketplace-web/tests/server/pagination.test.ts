import { describe, expect, it } from 'vitest'
import { parsePageParams } from '~/server/utils/pagination'
import { makeEvent } from '../setup/server'

const parse = (query: Record<string, unknown>, opts?: { defaultPageSize?: number; maxPageSize?: number }) =>
  parsePageParams(makeEvent({ query }) as never, opts)

describe('parsePageParams', () => {
  it('defaults to page 1 / pageSize 24', () => {
    expect(parse({})).toEqual({ page: 1, pageSize: 24, limit: 24, offset: 0 })
  })

  it('computes offset from page and pageSize', () => {
    expect(parse({ page: '3', pageSize: '10' })).toEqual({ page: 3, pageSize: 10, limit: 10, offset: 20 })
  })

  it.each([
    [{ page: '0' }, 1],
    [{ page: 'abc' }, 1],
    [{ page: '-2' }, 1],
  ])('clamps an invalid page %o to 1', (query, expected) => {
    expect(parse(query).page).toBe(expected)
  })

  it('falls back to the default pageSize for empty/zero, and caps at the max', () => {
    expect(parse({ pageSize: '0' }).pageSize).toBe(24)
    expect(parse({ pageSize: '10000' }).pageSize).toBe(100)
  })

  it('honours custom opts', () => {
    expect(parse({ pageSize: '500' }, { defaultPageSize: 50, maxPageSize: 200 }).pageSize).toBe(200)
    expect(parse({}, { defaultPageSize: 50 }).pageSize).toBe(50)
  })

  it('takes the first value of an array param', () => {
    expect(parse({ pageSize: ['15', '99'] }).pageSize).toBe(15)
  })
})
