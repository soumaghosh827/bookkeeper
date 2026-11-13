import type { DB } from "../db";
import type { TxHistoryEntry } from "@shared/types";

/** Appends to audit_log. `changes` = { field: [old, new] }. Never throws into the caller's flow. */
export function audit(
  db: DB,
  table: string,
  rowId: string,
  action: "create" | "update" | "delete",
  changes: Record<string, unknown> = {},
  reason: string | null = null,
) {
  db.prepare(
    "INSERT INTO audit_log(at, table_name, row_id, action, changes, reason) VALUES (?,?,?,?,?,?)",
  ).run(
    new Date().toISOString(),
    table,
    rowId,
    action,
    JSON.stringify(changes),
    reason,
  );
}

/** Audit trail of one row of any table, newest first. Uses the row_id index. */
export function rowHistory(
  db: DB,
  table: string,
  rowId: string,
): TxHistoryEntry[] {
  const rows = db
    .prepare(
      "SELECT at, action, changes, reason FROM audit_log WHERE table_name = ? AND row_id = ? ORDER BY id DESC",
    )
    .all(table, rowId) as {
    at: string;
    action: TxHistoryEntry["action"];
    changes: string;
    reason: string | null;
  }[];
  return rows.map((r) => {
    let changes: TxHistoryEntry["changes"] = {};
    try {
      changes = JSON.parse(r.changes);
    } catch {
      /* keep empty */
    }
    return { at: r.at, action: r.action, changes, reason: r.reason };
  });
}
