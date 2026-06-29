import { sql, type Expression, type SqlBool } from 'kysely'
import type { SearchSort } from '~/models'

// Treat LIKE wildcards in user input literally (backslash is PG's default escape).
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, c => `\\${c}`)

// Pure: the ORDER BY strategy a search sort maps to. The default ('relevance') → null, meaning
// "apply the shared default listing order" (status rank + tie-breaks) so a sort-free search
// paginates exactly like the listings — no extra clause. The repo (itemRepo) translates the
// non-null keys to concrete ORDER BY builders; keeping the decision here makes it DB-free testable.
export type SearchOrderKey = 'newest' | 'priceAsc' | 'priceDesc'

export const searchOrderKey = (sort: SearchSort | undefined): SearchOrderKey | null =>
  sort === 'newest' ? 'newest' : sort === 'priceAsc' ? 'priceAsc' : sort === 'priceDesc' ? 'priceDesc' : null

// Diacritics- and case-insensitive substring match: fold both column and term with
// unaccent so "ceske budejovice" matches "České Budějovice" and "skoda" matches
// "Škoda". Each target is coalesced to text so NULL columns never match. Returns the
// per-target predicates for eb.or(...); pass an already-trimmed, non-empty term.
//
// Uses immutable_unaccent (migration 014) rather than unaccent() so the predicate matches
// the pg_trgm functional indexes — the planner only uses them when the expression is identical.
export const unaccentLikeAny = (targets: ReadonlyArray<Expression<unknown>>, term: string): Expression<SqlBool>[] => {
  const pattern = `%${escapeLike(term)}%`
  return targets.map(
    t => sql<SqlBool>`lower(immutable_unaccent(coalesce((${t})::text, ''))) like lower(immutable_unaccent(${pattern}))`,
  )
}
