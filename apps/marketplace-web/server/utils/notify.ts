import { winNotification, outbidNotification, answerNotification } from '~/models'
import type { NewNotification } from '~/models'
import { createNotification } from '../repos/notificationRepo'
import { captureServerError } from './observability'

// Best-effort in-app emit: a notification must never fail the flow that raised it (a bid, an auction
// close, an answer). Errors are logged and swallowed — same policy as contact/question notifyOps. The
// repo's dedupe_key makes a re-raised event a no-op, so retrying a flow can't double-notify.
const emit = async (n: NewNotification, area: string): Promise<void> => {
  try {
    await createNotification(n)
  } catch (e) {
    captureServerError(e, { area, tags: { userId: n.userId } })
  }
}

export const notifyWin = (itemId: string, winnerId: string, title: string): Promise<void> =>
  emit(winNotification(itemId, winnerId, title), 'notify.win')

export const notifyOutbid = (itemId: string, outbidUserId: string, title: string): Promise<void> =>
  emit(outbidNotification(itemId, outbidUserId, title), 'notify.outbid')

export const notifyAnswer = (questionId: string, askerId: string, itemId: string, title: string): Promise<void> =>
  emit(answerNotification(questionId, askerId, itemId, title), 'notify.answer')
