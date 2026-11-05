import type { DB } from '../db'
import { customKey, isCustomKey, type CustomColumn, type Result, type Scope } from '@shared/types'
import { MAX_CUSTOM_COLUMNS } from '@shared/rules'

type Row = Record<string, any>
const toCol = (r: Row): CustomColumn => ({ key: r.key, label: r.label, scope: r.scope, position: r.position, archived: !!r.archived })
const getCol = (db: DB, key: string) => toCol(db.prepare('SELECT * FROM custom_fields WHERE key = ?').get(key) as Row)
const badName = (s: string) => (!s || s.length > 40 ? 'Name must be 1 to 40 characters' : null)
const okScope = (s: string): s is Scope => s === 'account' || s === 'transaction'

function labelTaken(db: DB, label: string, scope: Scope, exceptKey = ''): boolean {
  const l = label.toLowerCase()
  const standard = (db.prepare('SELECT label FROM field_labels').all() as { label: string }[]).some((r) => r.label.toLowerCase() === l)
  const custom = db.prepare("SELECT 1 FROM custom_fields WHERE scope = ? AND archived = 0 AND lower(label) = ? AND key <> ? LIMIT 1").get(scope, l, exceptKey)
  return standard || !!custom
}

export function listCustomColumns(db: DB, scope: Scope, includeArchived = false): CustomColumn[] {
  if (!okScope(scope)) return []
  return (db.prepare(`SELECT * FROM custom_fields WHERE scope = ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY position, key`).all(scope) as Row[]).map(toCol)
}

export function addCustomColumn(db: DB, scope: Scope, rawLabel: string): Result<CustomColumn> {
  if (!okScope(scope)) return { ok: false, error: 'Invalid column type' }
  const label = String(rawLabel).trim()
  const bad = badName(label)
  if (bad) return { ok: false, error: bad }
  const hidden = db.prepare("SELECT key FROM custom_fields WHERE scope = ? AND archived = 1 AND lower(label) = lower(?)").get(scope, label) as { key: string } | undefined
  if (hidden) { // same name as a hidden column: bring it back with its data
    db.prepare('UPDATE custom_fields SET archived = 0 WHERE key = ?').run(hidden.key)
    return { ok: true, data: getCol(db, hidden.key) }
  }
  if (labelTaken(db, label, scope)) return { ok: false, error: 'A column with this name already exists' }
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM custom_fields WHERE scope = ? AND archived = 0").get(scope) as { n: number }
  if (n >= MAX_CUSTOM_COLUMNS) return { ok: false, error: `You can add up to ${MAX_CUSTOM_COLUMNS} custom columns` }
  const base = customKey(label)
  let key = base, i = 2
  while (db.prepare('SELECT 1 FROM custom_fields WHERE key = ?').get(key)) key = `${base}_${i++}`
  db.prepare("INSERT INTO custom_fields (key, label, scope, position, archived) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM custom_fields), 0)").run(key, label, scope)
  return { ok: true, data: getCol(db, key) }
}

export function renameCustomColumn(db: DB, key: string, rawLabel: string): Result<CustomColumn> {
  const label = String(rawLabel).trim()
  const bad = badName(label)
  if (bad) return { ok: false, error: bad }
  const cur = isCustomKey(key) ? (db.prepare('SELECT * FROM custom_fields WHERE key = ?').get(key) as Row | undefined) : undefined
  if (!cur) return { ok: false, error: 'Column not found' }
  if (labelTaken(db, label, cur.scope, key)) return { ok: false, error: 'A column with this name already exists' }
  db.prepare('UPDATE custom_fields SET label = ? WHERE key = ?').run(label, key) // key never changes
  return { ok: true, data: getCol(db, key) }
}

export function archiveCustomColumn(db: DB, key: string, archived: boolean): Result {
  db.prepare('UPDATE custom_fields SET archived = ? WHERE key = ?').run(archived ? 1 : 0, key) // values stay in the rows
  return { ok: true }
}

export function reorderCustomColumns(db: DB, scope: Scope, keys: string[]): Result {
  const st = db.prepare('UPDATE custom_fields SET position = ? WHERE key = ? AND scope = ?')
  db.transaction(() => keys.forEach((k, i) => st.run(i + 1, k, scope)))()
  return { ok: true }
}
