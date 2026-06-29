// A complaint a buyer opens against a completed (settled) sale, moved through a small state machine
// by ops until it reaches a documented decision. Bound to the settled invoice (one sale → one case),
// so a complaint always traces to a real transaction. Dates are epoch-ms numbers (the FE/mapper
// contract). See features/sale/disputes-complaints.
export type DisputeStatus = 'open' | 'review' | 'resolved'

export const DISPUTE_STATUSES: readonly DisputeStatus[] = ['open', 'review', 'resolved']

export interface Dispute {
  id: string
  itemId: string
  invoiceId: string
  openerId: string
  reason: string
  status: DisputeStatus
  resolution?: string
  resolvedBy?: string
  resolvedAt?: number // epoch millis
  created: number // epoch millis
}

// Repo input — opener + invoice are server-derived from the settled sale, never client-supplied. Only
// the reason is user text.
export interface NewDispute {
  itemId: string
  invoiceId: string
  openerId: string
  reason: string
}

export const DISPUTE_REASON_MAX = 5000
export const DISPUTE_RESOLUTION_MAX = 5000

export const disputeReasonError = (reason: unknown): { status: number; message: string } | null => {
  if (typeof reason !== 'string') return { status: 422, message: 'A reason is required' }
  const trimmed = reason.trim()
  if (!trimmed) return { status: 422, message: 'A reason is required' }
  if (trimmed.length > DISPUTE_REASON_MAX) return { status: 422, message: 'Reason is too long' }
  return null
}

export const disputeResolutionError = (text: unknown): { status: number; message: string } | null => {
  if (typeof text !== 'string') return { status: 422, message: 'A resolution note is required' }
  const trimmed = text.trim()
  if (!trimmed) return { status: 422, message: 'A resolution note is required' }
  if (trimmed.length > DISPUTE_RESOLUTION_MAX) return { status: 422, message: 'Resolution note is too long' }
  return null
}

// The state machine. A case moves forward open → review → resolved (open may also resolve directly);
// resolved is terminal — no decision is ever reopened or un-made. Pure so the repo guard and any UI
// share one truth. Justice that arrives once and stays.
const ALLOWED_TRANSITIONS: Record<DisputeStatus, readonly DisputeStatus[]> = {
  open: ['review', 'resolved'],
  review: ['resolved'],
  resolved: [],
}

export const canTransitionDispute = (from: DisputeStatus, to: DisputeStatus): boolean =>
  ALLOWED_TRANSITIONS[from]?.includes(to) ?? false

export const isDisputeResolved = (d: Pick<Dispute, 'status'>): boolean => d.status === 'resolved'
