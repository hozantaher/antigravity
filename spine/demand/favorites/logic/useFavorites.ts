// Module-level so the in-flight guard is shared across every component using the composable.
const pending = new Set<string>()

export default function useFavorites() {
  const { isLogged, user } = useUser()
  const localePath = useLocalePath()

  const toggleFavorite = async (id: string) => {
    if (!isLogged.value) {
      await navigateTo(localePath('/sign'))
      return
    }
    // Ignore rapid re-clicks: the server toggle flips on each call, so a double-fire would net
    // back to the original state and a late response could overwrite a newer one.
    if (pending.has(id)) return
    pending.add(id)
    try {
      const res = await $fetch<{ favoriteIds: string[] }>('/api/favorites/toggle', {
        method: 'POST',
        body: { id },
      })
      if (user.value) user.value.favoriteIds = res.favoriteIds
    } finally {
      pending.delete(id)
    }
  }

  return { toggleFavorite }
}
