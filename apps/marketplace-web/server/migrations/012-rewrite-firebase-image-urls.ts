import { type Kysely, sql } from 'kysely'

// One-off data migration: the Firebase Storage bucket moved from the old auction24 project to
// garaaage-auction24, so every stored item image URL still points at the old host. Rewrite the
// host in `image` (scalar) and the `images` / `images360` text[] columns, in place.
const OLD = 'auction-30922.appspot.com'
const NEW = 'garaaage-auction24.firebasestorage.app'

const ARRAY_COLUMNS = ['images', 'images360'] as const

const rewriteHost = async (db: Kysely<unknown>, from: string, to: string): Promise<void> => {
  const like = `%${from}%`

  await sql`update items set image = replace(image, ${from}, ${to}) where image like ${like}`.execute(db)

  // text[] columns: rebuild element-wise, preserving order (WITH ORDINALITY + ORDER BY). The WHERE
  // guard skips untouched/empty rows; coalesce back to the original keeps the array if no elements.
  for (const column of ARRAY_COLUMNS) {
    const col = sql.ref(column)
    await sql`
      update items
      set ${col} = coalesce(
        (select array_agg(replace(elem, ${from}, ${to}) order by ord)
         from unnest(${col}) with ordinality as u(elem, ord)),
        ${col}
      )
      where array_to_string(${col}, ',') like ${like}
    `.execute(db)
  }
}

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await rewriteHost(db, OLD, NEW)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await rewriteHost(db, NEW, OLD)
}
