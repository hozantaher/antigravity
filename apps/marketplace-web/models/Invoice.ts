import type { Price } from './Price'

// Single source of truth for invoice lifecycle strings — a typo'd raw literal
// compiles fine and silently matches nothing.
export const INVOICE_STATUS = {
  unpaid: 'unpaid',
  paid: 'paid',
  canceled: 'canceled',
} as const

export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS]

export interface Invoice {
  id: string
  createdDate?: number
  invoiceCreatedDate?: number
  invoiceDueDate?: number
  paidAt?: number
  status: string
  price?: Price
  url?: string
  userId: string
  // The DB column already exists (`Generated<string>`, default 'deposit'); the model just surfaces
  // it now so a caller can tell a deposit proforma from a sale invoice. Optional: older callers and
  // the existing invoice mapper that don't set it stay valid.
  type?: 'deposit' | 'sale'
}
