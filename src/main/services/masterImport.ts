import ExcelJS from 'exceljs'
import { randomUUID } from 'crypto'
import type { DB } from '../db'
import {
  ACCOUNT_KEYS, customKey, isCustomKey,
  type AccountKey, type ColumnMapping, type CustomColumn, type ImportFileInfo, type ImportOptions, type ImportPreview, type ImportProblem
} from '@shared/types'
import { cleanIfsc, isValidIfsc } from '@shared/format'

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '') // "A/C No." -> "acno"

// Extend this list whenever you meet a new header variation.
const SYNONYMS: Record<AccountKey, string[]> = {
  payee: ['payee', 'payeename', 'name', 'beneficiary', 'beneficiaryname', 'nameofpayee', 'nameofbeneficiary', 'accountholder', 'accountholdername'],
  account_no: ['acno', 'accno', 'accountno', 'accountnumber', 'acnumber', 'bankaccountno', 'bankacno', 'beneficiaryaccountno', 'beneficiaryaccountnumber'],
  bank: ['bank', 'bankname', 'nameofbank'],
  branch: ['branch', 'branchname', 'bankbranch'],
  ifsc: ['ifsc', 'ifsccode', 'ifscno', 'ifscnumber'],
  remarks: ['remarks', 'remark', 'note', 'notes', 'narration', 'particulars', 'description']
}
const SYN = new Map<string, AccountKey>()
for (const k of ACCOUNT_KEYS) for (const s of SYNONYMS[k]) SYN.set(s, k)
const POSITIONAL: AccountKey[] = ['payee', 'bank', 'branch', 'account_no', 'ifsc', 'remarks'] // headerless paste

// The parsed input is held in main-process memory between steps (never sent whole to the UI).
let session: { source: string; headers: string[]; rows: { n: number; cells: string[] }[] } | null = null

/** Minimal TSV parser (what Excel puts on the clipboard), including "quoted\tcells" and doubled quotes. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  const t = text.replace(/\r\n?/g, '\n')
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += ch
    } else if (ch === '"' && cell === '') q = true
    else if (ch === '\t') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.map((r) => r.map((c) => c.trim()))
}

function autoMap(db: DB, headers: string[], headerless: boolean): { mapping: ColumnMapping; customFields: CustomColumn[] } {
  const customFields = (db.prepare("SELECT key, label, scope, position, archived FROM custom_fields WHERE scope = 'account' AND archived = 0 ORDER BY position, key").all() as any[])
    .map((r) => ({ ...r, archived: !!r.archived })) as CustomColumn[]
  if (headerless) return { mapping: headers.map((_, i) => POSITIONAL[i] ?? null), customFields }
  const byLabel = new Map(customFields.map((c) => [norm(c.label), c.key]))
  const saved = new Map((db.prepare('SELECT header, field_key FROM import_mappings').all() as any[]).map((r) => [r.header as string, r.field_key as string]))
  const used = new Set<string>()
  const mapping = headers.map((h) => {
    const n = norm(h)
    const key = saved.get(n) ?? SYN.get(n) ?? byLabel.get(n) ?? null
    if (key && !used.has(key) && ((ACCOUNT_KEYS as readonly string[]).includes(key) || isCustomKey(key))) { used.add(key); return key }
    return null
  })
  return { mapping, customFields }
}

function setSession(db: DB, source: string, grid: string[][], hasHeader: boolean): ImportFileInfo {
  const width = Math.max(0, ...grid.map((r) => r.length))
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? '')
  const headers = hasHeader ? pad(grid[0]).map((h, i) => h || `Column ${i + 1}`) : Array.from({ length: width }, (_, i) => `Column ${i + 1}`)
  const body = hasHeader ? grid.slice(1) : grid
  const rows = body.map((cells, i) => ({ n: i + (hasHeader ? 2 : 1), cells: pad(cells) })).filter((r) => r.cells.some((x) => x !== ''))
  if (!rows.length) throw new Error(hasHeader ? 'Need a header row and at least one data row' : 'Nothing to import')
  session = { source, headers, rows }
  return { source, headers, rowCount: rows.length, ...autoMap(db, headers, !hasHeader) }
}

export async function loadFile(db: DB, filePath: string): Promise<ImportFileInfo> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('No sheet found in file')
  const width = ws.columnCount
  const grid: string[][] = []
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = []
    for (let c = 1; c <= width; c++) cells.push((row.getCell(c).text ?? '').trim()) // .text keeps long account numbers as shown
    grid.push(cells)
  })
  return setSession(db, filePath.split(/[\\/]/).pop()!, grid, true)
}
export const loadPaste = (db: DB, text: string, hasHeader: boolean) => setSession(db, 'Pasted cells', parseTsv(String(text).slice(0, 5_000_000)), hasHeader)

function evaluate(db: DB, mapping: ColumnMapping) {
  if (!session) throw new Error('Nothing loaded. Start the import again.')
  const core = ACCOUNT_KEYS as readonly string[]
  if (!Array.isArray(mapping) || mapping.length !== session.headers.length || mapping.some((k) => k !== null && !core.includes(k) && !isCustomKey(k)))
    throw new Error('Invalid mapping')
  const picked = mapping.filter(Boolean) as string[]
  if (new Set(picked).size !== picked.length) throw new Error('Two columns map to the same field')
  if (!picked.includes('payee')) throw new Error('Map at least the Beneficiary column')

  const byNo = db.prepare('SELECT id, payee, bank FROM accounts WHERE in_master = 1 AND account_no = ? LIMIT 1')
  const byPayeeIfsc = db.prepare('SELECT id, payee, bank FROM accounts WHERE in_master = 1 AND lower(payee) = lower(?) AND ifsc = ? LIMIT 1')
  const seenNo = new Set<string>(), seenSoft = new Set<string>()

  return session.rows.map(({ n, cells }) => {
    const v: Record<string, string> = {}
    mapping.forEach((k, i) => { if (k) v[k] = cells[i] ?? '' })
    const a = {
      payee: (v.payee ?? '').trim(), bank: (v.bank ?? '').trim(), branch: (v.branch ?? '').trim(),
      account_no: (v.account_no ?? '').replace(/\s/g, ''), ifsc: cleanIfsc(v.ifsc ?? ''), remarks: (v.remarks ?? '').trim()
    }
    const extra: Record<string, string> = {}
    for (const k of picked) if (isCustomKey(k) && v[k]?.trim()) extra[k] = v[k].trim()

    const issues: string[] = []
    if (!a.payee) issues.push('Missing beneficiary')
    if (a.ifsc && !isValidIfsc(a.ifsc)) issues.push('Invalid IFSC')

    let status: 'new' | 'invalid' | 'duplicate' | 'similar' = issues.length ? 'invalid' : 'new'
    let existingId: string | null = null, existing = ''
    if (!issues.length) {
      const hit = a.account_no ? (byNo.get(a.account_no) as any) : null
      if (hit) { status = 'duplicate'; existingId = hit.id; existing = `${hit.payee} · ${hit.bank}` }
      else if (a.account_no && seenNo.has(a.account_no)) { status = 'duplicate'; existing = 'Earlier row in this file' }
      else {
        const soft = a.ifsc ? (byPayeeIfsc.get(a.payee, a.ifsc) as any) : null
        if (soft) { status = 'similar'; existing = `${soft.payee} · ${soft.bank}` }
        else if (a.ifsc && seenSoft.has(a.payee.toLowerCase() + '|' + a.ifsc)) { status = 'similar'; existing = 'Earlier row in this file' }
      }
      if (a.account_no) seenNo.add(a.account_no)
      if (a.ifsc) seenSoft.add(a.payee.toLowerCase() + '|' + a.ifsc)
    }
    return { n, v, a, extra, issues, status, existingId, existing }
  })
}

export function preview(db: DB, mapping: ColumnMapping): ImportPreview {
  const ev = evaluate(db, mapping)
  const count = (s: string) => ev.filter((e) => e.status === s).length
  const problems: ImportProblem[] = ev
    .filter((e) => e.status !== 'new')
    .slice(0, 200)
    .map((e) => ({ row: e.n, status: e.status as ImportProblem['status'], issues: e.issues, values: e.v, existing: e.existing || undefined }))
  return { total: ev.length, fresh: count('new'), invalid: count('invalid'), duplicates: count('duplicate'), similar: count('similar'), problems }
}

export function commit(db: DB, mapping: ColumnMapping, opts: ImportOptions) {
  const ev = evaluate(db, mapping)
  const headers = session!.headers
  const now = new Date().toISOString()
  const ins = db.prepare(
    `INSERT INTO accounts (id, payee, bank, branch, account_no, ifsc, remarks, in_master, extra, created_at, updated_at)
     VALUES (@id, @payee, @bank, @branch, @account_no, @ifsc, @remarks, 1, @extra, @now, @now)`
  )
  const getExtra = db.prepare('SELECT extra FROM accounts WHERE id = ?')
  const upd = db.prepare('UPDATE accounts SET payee=@payee, bank=@bank, branch=@branch, ifsc=@ifsc, remarks=@remarks, extra=@extra, updated_at=@now WHERE id=@id')
  const saveMap = db.prepare('INSERT OR REPLACE INTO import_mappings(header, field_key) VALUES (?, ?)')
  const addCustom = db.prepare("INSERT OR IGNORE INTO custom_fields(key, label, scope, position) VALUES (?, ?, 'account', (SELECT COALESCE(MAX(position), 0) + 1 FROM custom_fields))")
  let added = 0, updated = 0

  db.transaction(() => {
    mapping.forEach((k, i) => {
      if (!k) return
      saveMap.run(norm(headers[i]), k)
      if (isCustomKey(k)) addCustom.run(k, headers[i].trim() || k)
    })
    for (const e of ev) {
      if (e.status === 'invalid') continue
      if (e.status === 'duplicate') {
        if (opts.onDuplicate === 'skip') continue
        if (opts.onDuplicate === 'update' && e.existingId) { // only non-empty cells overwrite; account number is the match key
          const cur = db.prepare('SELECT * FROM accounts WHERE id = ?').get(e.existingId) as any
          const extra = { ...JSON.parse((getExtra.get(e.existingId) as any).extra || '{}'), ...e.extra }
          upd.run({ id: e.existingId, now, extra: JSON.stringify(extra),
            payee: e.a.payee || cur.payee, bank: e.a.bank || cur.bank, branch: e.a.branch || cur.branch, ifsc: e.a.ifsc || cur.ifsc, remarks: e.a.remarks || cur.remarks })
          updated++
          continue
        }
        if (opts.onDuplicate === 'update') continue // duplicate of an earlier row in the same file: nothing to update
      }
      ins.run({ ...e.a, id: randomUUID(), extra: JSON.stringify(e.extra), now })
      added++
    }
  })()
  session = null
  return { added, updated, skipped: ev.length - added - updated }
}
export const clearSession = () => { session = null }
export { customKey }
