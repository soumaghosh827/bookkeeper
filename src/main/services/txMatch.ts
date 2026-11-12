import type { DB } from "../db";
import type { TxMatchKind } from "@shared/types";
import { refKey } from "./txReferences";

/** A saved (not deleted) transaction as the matcher sees it. */
export interface SavedTx {
  uid: string;
  refs: string[]; // in the order they were added
  created_at: string;
}
/** One transaction row of the file. ref "" = the row has no reference. */
export interface FileTx {
  key: string; // matchKey(account_no, paise, date)
  ref: string;
}
export type MatchOutcome =
  | { type: "new" } // no saved transaction left to compare with: import as new
  | { type: "same"; saved: SavedTx } // shares a reference with a saved transaction: the same transaction, nothing to add
  | { type: "ask"; kind: TxMatchKind; saved: SavedTx }; // looks like a saved transaction: the user decides

/** Identity key without the reference: account number + amount + date. */
export const matchKey = (no: string, paise: number, date: string) =>
  [no, paise, date].join("\u0001");

/** Saved transactions inside the file's date range, grouped by matchKey, oldest first. Two queries, however many rows. */
export function loadSavedTx(
  db: DB,
  lo: string,
  hi: string,
): Map<string, SavedTx[]> {
  const rows = db
    .prepare(
      `SELECT t.uid, a.account_no AS no, t.amount_paise AS amt, t.entry_date AS d, t.created_at
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.deleted_at IS NULL AND t.entry_date BETWEEN ? AND ?
        ORDER BY t.created_at, t.uid`,
    )
    .all(lo, hi) as {
    uid: string;
    no: string;
    amt: number;
    d: string;
    created_at: string;
  }[];
  const refs = new Map<string, string[]>();
  for (const r of db
    .prepare(
      `SELECT r.transaction_id AS uid, r.ref_no
         FROM transaction_references r JOIN transactions t ON t.uid = r.transaction_id
        WHERE t.deleted_at IS NULL AND t.entry_date BETWEEN ? AND ?
        ORDER BY r.id`,
    )
    .all(lo, hi) as { uid: string; ref_no: string }[]) {
    const l = refs.get(r.uid);
    if (l) l.push(r.ref_no);
    else refs.set(r.uid, [r.ref_no]);
  }
  const out = new Map<string, SavedTx[]>();
  for (const r of rows) {
    const k = matchKey(r.no, r.amt, r.d);
    const s: SavedTx = {
      uid: r.uid,
      refs: refs.get(r.uid) ?? [],
      created_at: r.created_at,
    };
    const l = out.get(k);
    if (l) l.push(s);
    else out.set(k, [s]);
  }
  return out;
}

/**
 * Pairs file rows with saved transactions of the same key, by count (a saved transaction is paired once).
 * Order inside one key:
 *  1. shared reference                      -> same (a saved transaction can be matched once per reference,
 *                                              so file rows {A} and {B} both match a saved {A, B})
 *  2. no reference vs saved with none       -> ask blank_match
 *  3. reference vs saved with none          -> ask ref_link
 *  4. no reference vs saved with references -> ask blank_match
 *  5. reference vs saved, none shared       -> ask ref_differs
 * Rows left over are new. Result is aligned with `rows`.
 */
export function matchRows(
  rows: FileTx[],
  saved: Map<string, SavedTx[]>,
): MatchOutcome[] {
  const out: MatchOutcome[] = rows.map(() => ({ type: "new" }));
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const g = groups.get(r.key);
    if (g) g.push(i);
    else groups.set(r.key, [i]);
  });

  for (const [key, idx] of groups) {
    const cands = saved.get(key);
    if (!cands?.length) continue;
    const keysOf = new Map<SavedTx, Set<string>>(
      cands.map((c) => [c, new Set(c.refs.map(refKey))]),
    );
    const claimed = new Map<SavedTx, Set<string>>(); // references already matched on a saved transaction
    const used = new Set<SavedTx>(); // saved transactions taken by any pass

    for (const i of idx) {
      const rk = refKey(rows[i].ref);
      if (!rk) continue;
      const c = cands.find(
        (c) => keysOf.get(c)!.has(rk) && !claimed.get(c)?.has(rk),
      );
      if (!c) continue;
      if (!claimed.has(c)) claimed.set(c, new Set());
      claimed.get(c)!.add(rk);
      used.add(c);
      out[i] = { type: "same", saved: c };
    }

    const pass = (
      rowBlank: boolean,
      savedBlank: boolean,
      kind: TxMatchKind,
    ) => {
      for (const i of idx) {
        if (out[i].type !== "new") continue;
        if ((refKey(rows[i].ref) === "") !== rowBlank) continue;
        const c = cands.find(
          (c) => !used.has(c) && (c.refs.length === 0) === savedBlank,
        );
        if (!c) continue;
        used.add(c);
        out[i] = { type: "ask", kind, saved: c };
      }
    };
    pass(true, true, "blank_match");
    pass(false, true, "ref_link");
    pass(true, false, "blank_match");
    pass(false, false, "ref_differs");
  }
  return out;
}
