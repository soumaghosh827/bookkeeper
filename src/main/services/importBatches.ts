// Import batches: undo for imports. Moved out of txImport.ts with no behavior change.
import { audit } from "./audit";
import { refreshAccountStats } from "./accounts";
import type { DB } from "../db";
import { getReferences, refsText } from "./txReferences";

export interface AccRow {
  id: string;
  payee: string;
  bank: string;
  branch: string;
  ifsc: string;
  remarks: string;
  in_master: number;
  extra: string;
  updated_at: string;
}
export interface AccountChange {
  id: string;
  at: string;
  prev: Omit<AccRow, "id">;
}

export interface UndoInfo {
  id: number;
  kind: "tx" | "master";
  created_at: string;
  file_name: string;
  transactions: number;
  edited: number; // imported transactions changed since the import (e.g. UTR added); undo deletes them too
  newAccounts: number;
  inReports: number; // imported transactions already used in a saved report
  refsLinked: number; // references this import added to transactions that already existed (undo removes them)
  canUndo: boolean;
}

/** The most recent import that has not been undone, or null. */
export function undoInfo(db: DB): UndoInfo | null {
  const b = db
    .prepare(
      "SELECT id, created_at, file_name, acc_count, kind FROM import_batches WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get() as
    | {
        id: number;
        created_at: string;
        file_name: string;
        acc_count: number;
        kind: "tx" | "master";
      }
    | undefined;
  if (!b) return null;
  const t = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(updated_at <> created_at), 0) AS edited FROM transactions WHERE batch_id = ?",
    )
    .get(b.id) as { n: number; edited: number };
  const r = db
    .prepare(
      "SELECT COUNT(DISTINCT tx_uid) AS n FROM report_items WHERE tx_uid IN (SELECT uid FROM transactions WHERE batch_id = ?)",
    )
    .get(b.id) as { n: number };
  const l = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transaction_references r
        WHERE r.batch_id = ?
          AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.uid = r.transaction_id AND t.batch_id = ?)`,
    )
    .get(b.id, b.id) as { n: number };
  return {
    id: b.id,
    kind: b.kind,
    created_at: b.created_at,
    file_name: b.file_name,
    transactions: t.n,
    edited: t.edited,
    newAccounts: b.acc_count,
    inReports: r.n,
    refsLinked: l.n,
    canUndo: r.n === 0,
  };
}

export function undoLastImport(db: DB) {
  const info = undoInfo(db);
  if (!info) throw new Error("There is no import to undo");
  if (!info.canUndo)
    throw new Error(
      `${info.inReports} imported transaction(s) are already in saved reports, so this import can no longer be undone`,
    );
  const changes = JSON.parse(
    (
      db
        .prepare("SELECT account_changes FROM import_batches WHERE id = ?")
        .get(info.id) as { account_changes: string }
    ).account_changes || "[]",
  ) as AccountChange[];
  const out = {
    transactions: 0,
    accountsRemoved: 0,
    accountsKept: 0,
    reverted: 0,
    revertSkipped: 0,
    refsRemoved: 0,
  };

  db.transaction(() => {
    // references the import linked to transactions that existed before it (the import's own transactions go below, with their references)
    const linked = db
      .prepare(
        `SELECT r.id, r.transaction_id AS uid FROM transaction_references r
          WHERE r.batch_id = ?
            AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.uid = r.transaction_id AND t.batch_id = ?)`,
      )
      .all(info.id, info.id) as { id: number; uid: string }[];
    for (const l of linked) {
      const before = getReferences(db, l.uid);
      db.prepare("DELETE FROM transaction_references WHERE id = ?").run(l.id);
      audit(
        db,
        "transactions",
        l.uid,
        "update",
        {
          reference_no: [refsText(before), refsText(getReferences(db, l.uid))],
        },
        "Reference removed: import undone",
      );
      out.refsRemoved++;
    }
    const touched = (
      db
        .prepare(
          "SELECT DISTINCT account_id FROM transactions WHERE batch_id = ?",
        )
        .all(info.id) as { account_id: string }[]
    ).map((r) => r.account_id);
    out.transactions = db
      .prepare("DELETE FROM transactions WHERE batch_id = ?")
      .run(info.id).changes;
    // accounts the import created go too, unless something else (a later manual entry) now uses them
    out.accountsRemoved = db
      .prepare(
        "DELETE FROM accounts WHERE batch_id = ? AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = accounts.id)",
      )
      .run(info.id).changes;
    out.accountsKept = (
      db
        .prepare("SELECT COUNT(*) AS n FROM accounts WHERE batch_id = ?")
        .get(info.id) as { n: number }
    ).n;
    // master accounts the import changed go back to their old values, unless the user edited them since
    for (const c of changes.reverse()) {
      const cur = db
        .prepare("SELECT updated_at FROM accounts WHERE id = ?")
        .get(c.id) as { updated_at: string } | undefined;
      if (!cur) continue;
      if (cur.updated_at !== c.at) {
        out.revertSkipped++;
        continue;
      }
      db.prepare(
        "UPDATE accounts SET payee=@payee, bank=@bank, branch=@branch, ifsc=@ifsc, remarks=@remarks, in_master=@in_master, extra=@extra, updated_at=@updated_at WHERE id=@id",
      ).run({ ...c.prev, id: c.id });
      out.reverted++;
    }
    for (const id of touched) refreshAccountStats(db, id);
    db.prepare("UPDATE import_batches SET undone_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      info.id,
    );
    audit(
      db,
      "import_batches",
      String(info.id),
      "delete",
      {
        transactions: [out.transactions, null],
        accounts: [out.accountsRemoved, null],
        accounts_restored: [out.reverted, null],
        references_removed: [out.refsRemoved, null],
      },
      info.kind === "master" ? "Accounts import undone" : "Import undone",
    );
  })();
  return out;
}
