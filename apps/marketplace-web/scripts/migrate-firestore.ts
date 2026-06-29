#!/usr/bin/env tsx
// Migrate the garaaage-auction24 Firestore `users` and `ads` collections into
// Postgres, keyed by Firebase UID. Existing accounts keep their identity on
// first login: createOrGetUser finds the migrated row (roles, favorites, …)
// instead of minting a blank one. Credentials are NOT migrated here — the
// Firebase Auth pool must already hold these users.
//
// Prereq: `pnpm db:migrate up` (tables) + .env with POSTGRES_URL and
// GOOGLE_APPLICATION_CREDENTIALS (service account for garaaage-auction24).
//
// Usage: pnpm migrate:firestore [--dry-run] [--skip-orphans] [--invoices] [--owner=<uid>]
//   --dry-run       read + map + report, write nothing
//   --skip-orphans  drop ads/bids whose user is missing (default: placeholder row)
//   --invoices      also migrate the users/{uid}/invoices subcollections
//   --owner=<uid>   assign ads that have no userId to this user (else they're skipped)
import { loadEnv } from './load-env'

loadEnv()
// Batch work: opt out of the request-path statement timeout (bulk import runs long).
process.env.POSTGRES_STATEMENT_TIMEOUT ??= '0'

const log = (m: string): void => console.log(`[migrate] ${m}`)

const main = async (): Promise<void> => {
  const flags = new Set(process.argv.slice(2))
  const dryRun = flags.has('--dry-run')
  const skipOrphans = flags.has('--skip-orphans')
  const withInvoices = flags.has('--invoices')
  const fallbackOwner = [...flags].find(f => f.startsWith('--owner='))?.slice('--owner='.length)

  // Dynamic imports after loadEnv() so db.ts / firebase.ts read the loaded env.
  const { getFirestoreAdmin } = await import('../server/utils/firebase')
  const { destroyDb } = await import('../server/utils/db')
  const { firestoreToUser, firestoreToItem, firestoreToBids, firestoreToInvoice, placeholderUser } =
    await import('../server/repos/fromFirestore')
  const { userToInsert, itemToInsert, bidToInsert, invoiceToInsert } = await import('../server/repos/mappers')
  const { upsertUsers, insertUsersIfMissing, upsertItems, replaceBidsForItems, upsertInvoices } =
    await import('../server/repos/migrationRepo')

  const fs = getFirestoreAdmin()

  try {
    // 1. users
    const userDocs = (await fs.collection('users').get()).docs
    const users = userDocs.map(doc => firestoreToUser(doc.id, doc.data()))
    const userIds = new Set(users.map(u => u.id))
    log(`loaded ${users.length} users`)

    // 2. ads → items (+ embedded bids); ownerless ads go to --owner or are dropped
    const adDocs = (await fs.collection('ads').get()).docs
    let reassigned = 0
    const ads = adDocs
      .map(doc => {
        const item = firestoreToItem(doc.id, doc.data())
        if (!item.userId && fallbackOwner) {
          item.userId = fallbackOwner
          reassigned++
        }
        return { item, bids: firestoreToBids(doc.data()) }
      })
      .filter(a => {
        if (a.item.userId) return true
        log(`skip ad ${a.item.id}: missing userId (pass --owner=<uid> to assign a fallback)`)
        return false
      })
    if (reassigned) log(`reassigned ${reassigned} ownerless ads → ${fallbackOwner}`)
    log(`loaded ${ads.length} ads`)

    // 3. referential integrity — userIds referenced by ads/bids but not migrated
    const referenced = new Set<string>()
    for (const a of ads) {
      referenced.add(a.item.userId)
      for (const b of a.bids) if (b.userId) referenced.add(b.userId)
    }
    const missing = [...referenced].filter(id => !userIds.has(id))
    const missingSet = new Set(missing)

    let keptAds = ads
    const placeholders = skipOrphans ? [] : missing.map(placeholderUser)
    if (missing.length) {
      if (skipOrphans) {
        keptAds = ads
          .filter(a => !missingSet.has(a.item.userId))
          .map(a => ({ item: a.item, bids: a.bids.filter(b => !missingSet.has(b.userId)) }))
        log(`orphans: ${missing.length} missing users → skipped their ads/bids`)
      } else {
        missing.forEach(id => userIds.add(id))
        log(`orphans: ${missing.length} missing users → placeholder rows`)
      }
    }

    const items = keptAds.map(a => a.item)
    // Final FK guard: only keep bids whose bidder will exist in the DB.
    const bidRows = keptAds.flatMap(a => a.bids.filter(b => userIds.has(b.userId)).map(b => bidToInsert(a.item.id, b)))

    if (dryRun) {
      log('DRY RUN — nothing written')
      log(
        `would write: ${users.length} users + ${placeholders.length} placeholders, ${items.length} items, ${bidRows.length} bids`,
      )
      return
    }

    // 4. write in FK order: users (+ placeholders) → items → bids
    await upsertUsers(users.map(userToInsert))
    if (placeholders.length) await insertUsersIfMissing(placeholders.map(userToInsert))
    await upsertItems(items.map(itemToInsert))
    await replaceBidsForItems(
      items.map(i => i.id),
      bidRows,
    )
    log(`wrote ${users.length + placeholders.length} users, ${items.length} items, ${bidRows.length} bids`)

    // 5. invoices (opt-in) — subcollection users/{uid}/invoices, FK to an existing user
    if (withInvoices) {
      const invDocs = (await fs.collectionGroup('invoices').get()).docs
      const invoices = invDocs.map(doc => firestoreToInvoice(doc.id, doc.data())).filter(inv => userIds.has(inv.userId))
      await upsertInvoices(invoices.map(invoiceToInsert))
      log(`wrote ${invoices.length} invoices`)
    }
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    await destroyDb()
  }
}

main()
