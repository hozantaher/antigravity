import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { ref, type Ref } from 'vue'

import useItemQuestions from '~/features/demand/messaging/logic/useItemQuestions'
import type { Paginated, PublicQuestion } from '~/models'

// The composable owns a lazy client-only useAsyncData fetch. Stub useAsyncData to (1) capture the
// key/fetcher/options so we can assert the real request shape and the lazy/no-SSR posture, and
// (2) hand back a controllable `data` ref so the questions/total derivation is testable
// deterministically (the real lazy+server:false fetch doesn't settle inside mountSuspended).
interface Captured {
  key: unknown
  handler?: () => Promise<unknown>
  options?: Record<string, unknown>
  data: Ref<Paginated<PublicQuestion> | undefined>
  refresh: ReturnType<typeof vi.fn>
}

// Lazily constructed (ref/vi.fn need the vue/vitest imports), assigned in beforeEach.
let captured: Captured

mockNuxtImport('useAsyncData', () => {
  return (key: unknown, handler: () => Promise<unknown>, options: Record<string, unknown>) => {
    captured.key = typeof key === 'function' ? (key as () => unknown)() : key
    captured.handler = handler
    captured.options = options
    const def = options?.default as undefined | (() => Paginated<PublicQuestion>)
    if (def && captured.data.value === undefined) captured.data.value = def()
    return { data: captured.data, refresh: captured.refresh }
  }
})

const page = (items: PublicQuestion[], total = items.length): Paginated<PublicQuestion> => ({
  items,
  total,
  page: 1,
  pageSize: 10,
})

beforeEach(() => {
  vi.clearAllMocks()
  captured = { key: undefined, handler: undefined, options: undefined, data: ref(undefined), refresh: vi.fn() }
})

describe('useItemQuestions', () => {
  it('fetches /api/item/:id/questions with the current page + pageSize', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('$fetch', fetchSpy)

    useItemQuestions('itm1')
    await captured.handler!()

    expect(fetchSpy).toHaveBeenCalledWith('/api/item/itm1/questions', { query: { page: 1, pageSize: 10 } })
  })

  it('is lazy + client-only and re-fetches on page change (real server-side pagination)', () => {
    const { page: pageRef } = useItemQuestions('itm1')
    expect(captured.options).toMatchObject({ server: false, lazy: true })
    // The page ref is in the watch list, so changing it triggers useAsyncData's re-run.
    const watched = captured.options!.watch as unknown[]
    expect(watched).toContain(pageRef)
  })

  it('derives questions + total from the fetched page (newest-first comes from the endpoint)', () => {
    const { questions, total } = useItemQuestions('itm1')
    captured.data.value = page(
      [
        { id: 'q1', itemId: 'itm1', body: 'b1', status: 'published', created: 2 },
        { id: 'q0', itemId: 'itm1', body: 'b0', status: 'published', created: 1 },
      ],
      15,
    )
    expect(questions.value.map(q => q.id)).toEqual(['q1', 'q0'])
    expect(total.value).toBe(15)
  })

  it('defaults to an empty page and exposes refresh', () => {
    const { questions, total, refresh, pageSize } = useItemQuestions('itm1')
    expect(questions.value).toEqual([])
    expect(total.value).toBe(0)
    expect(pageSize).toBe(10)
    refresh()
    expect(captured.refresh).toHaveBeenCalled()
  })

  it('tracks a reactive item id in the fetch key + url', async () => {
    const id = ref<string | undefined>(undefined)
    useItemQuestions(() => id.value)
    // Key reflects the (currently empty) id.
    expect(captured.key).toBe('questions:item:')

    id.value = 'itm9'
    const fetchSpy = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('$fetch', fetchSpy)
    await captured.handler!()
    expect(fetchSpy).toHaveBeenCalledWith('/api/item/itm9/questions', { query: { page: 1, pageSize: 10 } })
  })
})
