// Fio Bank REST API v1 client (read-only transaction export).
// Docs: https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf — min. 30 s between calls
// per token (409 Conflict otherwise), token expires after 180 days.

const FIO_API_ROOT = 'https://fioapi.fio.cz/v1/rest'

export interface FioTransaction {
  id: string
  // YYYY-MM-DD (Fio's movement date), null when unparseable
  date: string | null
  amount: number
  currency: string
  vs: string | null
  counterAccount: string | null
  counterBankCode: string | null
  counterName: string | null
  message: string | null
  type: string | null
  raw: Record<string, unknown>
}

interface FioColumn {
  value?: string | number | null
}

type FioRawTransaction = Record<string, FioColumn | null | undefined>

const colValue = (tx: FioRawTransaction, key: string): string | number | null => {
  const value = tx[key]?.value
  return value === undefined || value === null || value === '' ? null : value
}

const colString = (tx: FioRawTransaction, key: string): string | null => {
  const value = colValue(tx, key)
  return value === null ? null : String(value).trim() || null
}

// The docs' JSON sample carries epoch ms, live API returns '2023-08-25+0200' — accept both.
const parseFioDate = (value: string | number | null): string | null => {
  if (value === null) return null
  if (typeof value === 'number') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }
  const head = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null
}

export const parseFioStatement = (payload: unknown): FioTransaction[] => {
  const statement = payload as {
    accountStatement?: { transactionList?: { transaction?: FioRawTransaction[] | null } | null } | null
  }
  const transactions = statement?.accountStatement?.transactionList?.transaction
  if (!Array.isArray(transactions)) return []

  const parsed: FioTransaction[] = []
  for (const tx of transactions) {
    const id = colValue(tx, 'column22')
    const amount = Number(colValue(tx, 'column1'))
    const currency = colString(tx, 'column14')
    if (id === null || !Number.isFinite(amount) || !currency) continue
    parsed.push({
      id: String(id),
      date: parseFioDate(colValue(tx, 'column0')),
      amount,
      currency,
      vs: colString(tx, 'column5'),
      counterAccount: colString(tx, 'column2'),
      counterBankCode: colString(tx, 'column3'),
      counterName: colString(tx, 'column10'),
      message: colString(tx, 'column16'),
      type: colString(tx, 'column8'),
      raw: tx as Record<string, unknown>,
    })
  }
  return parsed
}

// Movements in [from, to] (YYYY-MM-DD, inclusive). Returns null on Fio's 30s
// throttle (409) so the caller can skip this run; the sliding window re-covers
// everything next time. The token is part of the URL — never let it leak into
// error messages or logs.
export const fetchFioTransactions = async (
  token: string,
  from: string,
  to: string,
): Promise<FioTransaction[] | null> => {
  const res = await fetch(`${FIO_API_ROOT}/periods/${token}/${from}/${to}/transactions.json`, {
    headers: { Accept: 'application/json' },
    // Statements can be slow, but a hung socket must not stall the whole cron run.
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 409) return null
  if (!res.ok) throw new Error(`Fio transactions fetch failed: HTTP ${res.status}`)
  return parseFioStatement(await res.json())
}
