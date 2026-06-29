import type { Price } from './Price'

export interface Bid extends Price {
  userId: string
  date: number // epoch millis (was Firebase Timestamp)
  avatarUrl?: string
}
