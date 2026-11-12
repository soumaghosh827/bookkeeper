import type { DB } from "../db";
import type { PreviewRow } from "@shared/types";
import { getReferencesMap, refsText } from "./txReferences";

const RC = "(SELECT COUNT(*) FROM report_items r WHERE r.tx_uid = t.uid)";

export function listPreview(db: DB): PreviewRow[] {
  const rows = db
    .prepare(
      `SELECT t.uid, p.position, a.payee, t.amount_paise, t.created_at, ${RC} AS report_count
     FROM preview_items p JOIN transactions t ON t.uid = p.tx_uid JOIN accounts a ON a.id = t.account_id
     WHERE t.deleted_at IS NULL ORDER BY p.position, p.added_at`,
    )
    .all() as PreviewRow[];
  const refs = getReferencesMap(
    db,
    rows.map((r) => r.uid),
  );
  for (const r of rows) r.reference_no = refsText(refs.get(r.uid) ?? []);
  return rows;
}

/** Appends to the working list (or inserts one item at an exact position, used by Undo). Already-listed items are ignored. */
export function addToPreview(db: DB, uids: string[], at?: number): number {
  const now = new Date().toISOString();
  const ins = db.prepare(
    "INSERT OR IGNORE INTO preview_items (tx_uid, position, added_at) SELECT uid, ?, ? FROM transactions WHERE uid = ? AND deleted_at IS NULL",
  );
  let added = 0;
  db.transaction(() => {
    let pos =
      at ??
      (
        db
          .prepare("SELECT COALESCE(MAX(position), 0) AS m FROM preview_items")
          .get() as { m: number }
      ).m + 1;
    for (const uid of uids) added += ins.run(pos++, now, String(uid)).changes;
  })();
  return added;
}
export const removeFromPreview = (db: DB, uid: string) =>
  void db.prepare("DELETE FROM preview_items WHERE tx_uid = ?").run(uid);
export const clearPreview = (db: DB) =>
  void db.prepare("DELETE FROM preview_items").run();
