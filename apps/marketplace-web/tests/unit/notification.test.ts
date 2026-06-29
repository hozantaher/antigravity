import { describe, expect, it } from 'vitest'
import { winNotification, outbidNotification, answerNotification, isNotificationRead } from '~/models'

describe('notification builders (one per key event)', () => {
  it('win → goes to the winner, deduped per item', () => {
    expect(winNotification('it1', 'u-win', 'BMW')).toEqual({
      userId: 'u-win',
      type: 'win',
      itemId: 'it1',
      title: 'BMW',
      dedupeKey: 'win:it1',
    })
  })

  it('outbid → goes to the outbid user, deduped per (item,user)', () => {
    expect(outbidNotification('it1', 'u-old', 'BMW')).toEqual({
      userId: 'u-old',
      type: 'outbid',
      itemId: 'it1',
      title: 'BMW',
      dedupeKey: 'outbid:it1:u-old',
    })
  })

  it('answer → goes to the asker, deduped per question', () => {
    expect(answerNotification('q9', 'u-ask', 'it1', 'BMW')).toEqual({
      userId: 'u-ask',
      type: 'answer',
      itemId: 'it1',
      title: 'BMW',
      dedupeKey: 'answer:q9',
    })
  })
})

describe('isNotificationRead', () => {
  it('is read only once readAt is set', () => {
    expect(isNotificationRead({ readAt: 123 })).toBe(true)
    expect(isNotificationRead({ readAt: undefined })).toBe(false)
  })
})
