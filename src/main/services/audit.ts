import type { DB } from '../db'

/** Appends to audit_log. `changes` = { field: [old, new] }. Never throws into the caller's flow. */
export function audit(db: DB, table: string, rowId: string, action: 'create' | 'update' | 'delete', changes: Record<string, unknown> = {}, reason: string | null = null) {
  db.prepare('INSERT INTO audit_log(at, table_name, row_id, action, changes, reason) VALUES (?,?,?,?,?,?)')
    .run(new Date().toISOString(), table, rowId, action, JSON.stringify(changes), reason)
}
