import type { Price } from './Price'

export type ContactKind = 'contact' | 'offer'
export type ContactStatus = 'new' | 'read' | 'archived'

// A message left through the public contact form or the "make an offer" action on a
// listing. Dates are epoch-ms and `offer` is a rehydrated Price (the FE/admin contract).
export interface ContactMessage {
  id: string
  kind: ContactKind
  name?: string
  email?: string
  phone?: string
  location?: string
  vehicle?: string
  message?: string
  itemId?: string
  userId?: string
  offer?: Price
  status: ContactStatus
  notifiedAt?: number
  created: number
}

// Repo input — flat (mirrors the columns), built by the contact endpoint after validation.
export interface NewContactMessage {
  kind: ContactKind
  name?: string
  email?: string
  phone?: string
  location?: string
  vehicle?: string
  message?: string
  itemId?: string
  userId?: string
  offerAmount?: number
  offerCurrency?: string
}
