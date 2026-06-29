import { formatPrice } from '~/utils'
import * as itemRepo from '../repos/itemRepo'
import * as userRepo from '../repos/userRepo'
import { enqueueEmail } from './emailQueue'
import { notifyWin } from './notify'
import { captureServerError } from './observability'

// One batch is enough headroom for the 5-minute cadence; any overflow is the next run's.
const BATCH_LIMIT = 200

export interface CloseAuctionsResult {
  processed: number
  sold: number
  unsold: number
  emailed: number
  errored: number
}

// Finalize every auction past its end: declare a winner (or not), mark it closed, and
// e-mail the winner. Closing and e-mailing are split into two idempotent passes — a row
// is closed in its own locked transaction, then a separate sweep (guarded by
// winner_emailed_at) mails winners, so an overlapping or crashed run never double-closes
// or double-mails. A per-item failure is logged and skipped, never aborting the batch.
export const closeEndedAuctions = async (limit = BATCH_LIMIT): Promise<CloseAuctionsResult> => {
  const result: CloseAuctionsResult = { processed: 0, sold: 0, unsold: 0, emailed: 0, errored: 0 }

  for (const id of await itemRepo.listClosableAuctionIds(limit)) {
    try {
      const outcome = await itemRepo.closeOneAuction(id)
      if (!outcome) continue // skipped: re-extended by a late bid or already closed
      result.processed++
      if (outcome.sold) result.sold++
      else result.unsold++
    } catch (e) {
      result.errored++
      captureServerError(e, { area: 'auction.close', tags: { itemId: id } })
    }
  }

  const baseUrl = useRuntimeConfig().public.baseUrl
  const pending = await itemRepo.listWinnersPendingEmail(limit)
  if (pending.length > 0) {
    // Two batched lookups instead of a per-winner getById (full item + full bid history) and N
    // user reads: the winning bid (newest bid = the price) and the winners, both keyed by id.
    const [bidByItem, winnerById] = await Promise.all([
      itemRepo.loadBidSummary(pending.map(p => p.itemId)),
      userRepo.getByIds(pending.map(p => p.winnerUserId)).then(us => new Map(us.map(u => [u.id, u]))),
    ])
    for (const { itemId, winnerUserId, title } of pending) {
      try {
        const winner = winnerById.get(winnerUserId)
        // No recipient (winner anonymized/deleted): stamp it so the sweep doesn't retry forever.
        if (!winner?.email) {
          await itemRepo.markWinnerEmailed(itemId)
          continue
        }
        await enqueueEmail(
          {
            recipient: winner.email,
            templateKey: 'auctionWon',
            language: winner.language?.code ?? 'cz',
            params: {
              itemTitle: title,
              itemUrl: `${baseUrl}/item/${itemId}`,
              winningAmount: formatPrice(bidByItem.get(itemId)?.last),
            },
          },
          { dedupKey: `auction-won:${itemId}` },
        )
        await notifyWin(itemId, winnerUserId, title) // in-app counterpart to the win e-mail (dedup'd)
        await itemRepo.markWinnerEmailed(itemId)
        result.emailed++
      } catch (e) {
        result.errored++
        captureServerError(e, { area: 'auction.close.email', tags: { itemId } })
      }
    }
  }

  return result
}
