import ExcelJS from 'exceljs'
import type { DB } from '../db'
import type { GridQuery } from '@shared/types'
import { getLabels } from './labels'
import { listCustomColumns } from './customColumns'
import { listTransactions } from './transactions'

/** Excel of the currently filtered / sorted transactions table. */
export async function buildTransactionsWorkbook(db: DB, q: GridQuery): Promise<{ buffer: Buffer; rows: number }> {
  const L = getLabels(db)
  const custom = listCustomColumns(db, 'transaction')
  const { rows } = listTransactions(db, { ...q, limit: -1, offset: 0 })

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Transactions', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [
    { header: L.reference_no, key: 'reference_no', width: 16 }, { header: L.entry_date, key: 'entry_date', width: 12, style: { numFmt: 'dd/mm/yyyy' } },
    { header: L.payee, key: 'payee', width: 28 }, { header: L.bank, key: 'bank', width: 22 }, { header: L.branch, key: 'branch', width: 20 },
    { header: L.account_no, key: 'account_no', width: 22, style: { numFmt: '@' } }, { header: L.ifsc, key: 'ifsc', width: 14 },
    { header: L.amount_paise, key: 'amount', width: 16, style: { numFmt: '#,##0.00' } },
    { header: L.utr, key: 'utr', width: 22 }, { header: L.notes, key: 'notes', width: 28 },
    ...custom.map((c) => ({ header: c.label, key: c.key, width: 20 }))
  ]
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF3' } }
  for (const r of rows) {
    const extra = JSON.parse(r.extra || '{}')
    const [y, m, d] = r.entry_date.split('-').map(Number)
    ws.addRow({
      reference_no: r.reference_no, entry_date: new Date(Date.UTC(y, m - 1, d)), payee: r.payee, bank: r.bank, branch: r.branch,
      account_no: r.account_no, ifsc: r.ifsc, amount: r.amount_paise / 100, utr: r.utr, notes: r.notes,
      ...Object.fromEntries(custom.map((c) => [c.key, extra[c.key] ?? '']))
    })
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), rows: rows.length }
}
