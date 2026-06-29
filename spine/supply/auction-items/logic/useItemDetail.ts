import { ItemType, type Item } from '~/models'

// Shared item-detail state. The page calls useItemDetail(true) to drive the fetch (and the live
// polling); child components (bids list, bid form) call useItemDetail() and just read the shared
// `item`.
export default function useItemDetail(load = false) {
  const route = useRoute()
  const { user } = useUser()
  const item = useState<Item | undefined>('itemDetail', () => undefined)
  // Resolves once the initial fetch settles (item set or left undefined on a 404), so the page
  // can turn a missing item into a real 404 response instead of rendering the skeleton at HTTP 200.
  let ready: Promise<void> | undefined

  // Re-pull the authoritative item (slim: last bid + current end/close/winner). Rarely needed now
  // that the live overlay patches the volatile fields in place — kept for an explicit hard refresh.
  const refresh = async () => {
    if (item.value) item.value = await $fetch<Item>(`/api/item/${item.value.id}`)
  }

  if (load) {
    const id = computed(() => route.params.itemId as string | undefined)
    // useAsyncData makes SSR await the fetch, so the item + hero render in the server HTML and the
    // result hydrates on the client without a refetch. The key is PER-ID (reactive): a constant
    // key let the asyncData reach status 'success' on the first item and then skip the fetch on a
    // later mount/navigation, stranding the page on the skeleton (no refetch, no 404). The reactive
    // key re-runs the handler on every navigation. The handler assigns `item` (shared state read by
    // child components) directly — the returned data ref does NOT follow a reactive key on a reused
    // component, so syncing from it would wipe `item` to undefined on navigation. Clear first so a
    // new id shows the skeleton while it loads instead of the previous item.
    const fetchState = useAsyncData(
      () => `itemDetail:${id.value ?? ''}`,
      async () => {
        item.value = undefined
        if (id.value) item.value = await $fetch<Item>(`/api/item/${id.value}`)
        return true
      },
    )
    ready = Promise.resolve(fetchState).then(() => undefined)

    // Live: poll the slim cached state and overlay it onto the item in place when a bid, the soft-
    // close-extended end, or the close/winner actually moved — no network round-trip. applyLiveItem
    // returns a NEW item (price/bidCount/end/winner patched); the bids panel watches bidCount and
    // refetches its own paginated page, so viewers see new bids and the extended countdown without
    // anyone touching the page and without re-downloading the whole item every tick.
    if (import.meta.client) {
      const { live } = useLiveItems(() => (item.value?.type === ItemType.auction ? [item.value] : []))
      watch(live, map => {
        const current = item.value
        const l = current && map.get(current.id)
        if (l && liveItemChanged(current, l)) item.value = applyLiveItem(current, l)
      })
    }
  }

  const placeBid = async (amount: number) => {
    item.value = await $fetch<Item>(`/api/item/${item.value!.id}/bid`, {
      method: 'POST',
      body: { amount, userId: user.value?.id },
    })
  }

  // Ask a question on the current item. POST only: the question lands moderated (pending), so it
  // won't appear in the thread until an admin publishes it, and questions are no longer embedded in
  // the item payload — so there's nothing to refetch on the item itself.
  const askQuestion = async (body: string) => {
    await $fetch(`/api/item/${item.value!.id}/question`, { method: 'POST', body: { body } })
  }

  return {
    item: computed(() => item.value),
    placeBid,
    askQuestion,
    refresh,
    ready,
  }
}
