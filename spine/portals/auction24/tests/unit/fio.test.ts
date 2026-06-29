import { describe, it, expect } from 'vitest'
import { parseFioStatement } from '~/server/utils/fio'

// Shape per Fio API docs (v1.9): transactionList.transaction[] with columnN objects.
const statement = (transactions: unknown[]) => ({
  accountStatement: {
    info: { accountId: '2903525501', currency: 'CZK', iban: 'CZ8820100000002903525501' },
    transactionList: { transaction: transactions },
  },
})

const fullTx = {
  column22: { value: 26962917278, name: 'ID pohybu', id: 22 },
  column0: { value: '2026-06-10+0200', name: 'Datum', id: 0 },
  column1: { value: 10000, name: 'Objem', id: 1 },
  column14: { value: 'CZK', name: 'Měna', id: 14 },
  column2: { value: '123456789', name: 'Protiúčet', id: 2 },
  column3: { value: '0800', name: 'Kód banky', id: 3 },
  column10: { value: 'Jan Novák', name: 'Název protiúčtu', id: 10 },
  column5: { value: '0001234567', name: 'VS', id: 5 },
  column16: { value: 'Kauce Jan Novák', name: 'Zpráva pro příjemce', id: 16 },
  column8: { value: 'Bezhotovostní příjem', name: 'Typ', id: 8 },
  column25: null,
}

describe('parseFioStatement', () => {
  it('parses a full transaction', () => {
    const [tx] = parseFioStatement(statement([fullTx]))
    expect(tx).toMatchObject({
      id: '26962917278',
      date: '2026-06-10',
      amount: 10000,
      currency: 'CZK',
      vs: '0001234567',
      counterAccount: '123456789',
      counterBankCode: '0800',
      counterName: 'Jan Novák',
      message: 'Kauce Jan Novák',
      type: 'Bezhotovostní příjem',
    })
  })

  it('tolerates null columns and the docs-sample epoch-ms date', () => {
    const [tx] = parseFioStatement(
      statement([
        {
          column22: { value: 1147608196 },
          // The PDF's JSON sample carries epoch ms; live API returns a date string.
          column0: { value: Date.UTC(2026, 5, 10, 12) },
          column1: { value: -352.5 },
          column14: { value: 'CZK' },
          column2: null,
          column5: null,
          column16: null,
        },
      ]),
    )
    expect(tx).toMatchObject({
      id: '1147608196',
      date: '2026-06-10',
      amount: -352.5,
      vs: null,
      counterAccount: null,
      message: null,
    })
  })

  it('skips transactions missing id, amount, or currency', () => {
    const parsed = parseFioStatement(
      statement([
        { column22: null, column1: { value: 5 }, column14: { value: 'CZK' } },
        { column22: { value: 1 }, column1: { value: 'x' }, column14: { value: 'CZK' } },
        { column22: { value: 2 }, column1: { value: 5 }, column14: null },
        { column22: { value: 3 }, column1: { value: 5 }, column14: { value: 'CZK' } },
      ]),
    )
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe('3')
  })

  it('returns [] for an empty or malformed payload', () => {
    expect(parseFioStatement(statement([]))).toEqual([])
    expect(parseFioStatement({ accountStatement: { transactionList: { transaction: null } } })).toEqual([])
    expect(parseFioStatement({})).toEqual([])
    expect(parseFioStatement(null)).toEqual([])
  })

  it('nulls an unparseable date instead of guessing', () => {
    const [tx] = parseFioStatement(
      statement([
        { column22: { value: 9 }, column0: { value: 'garbage' }, column1: { value: 1 }, column14: { value: 'CZK' } },
      ]),
    )
    expect(tx?.date).toBeNull()
  })
})
