import type { DB } from "../db";
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
  | { type: "ask"; kind: "ref_link" | "blank_match"; saved: SavedTx } // looks like a saved transaction: the user decides
  | { type: "differs"; saved: SavedTx }; // both have references, none shared: a genuine twin, info only

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
 *  5. reference vs saved, none shared       -> differs (info only, no decision)
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
      kind: "ref_link" | "blank_match" | "differs",
    ) => {
      for (const i of idx) {
        if (out[i].type !== "new") continue;
        if ((refKey(rows[i].ref) === "") !== rowBlank) continue;
        const c = cands.find(
          (c) => !used.has(c) && (c.refs.length === 0) === savedBlank,
        );
        if (!c) continue;
        used.add(c);
        out[i] =
          kind === "differs"
            ? { type: "differs", saved: c }
            : { type: "ask", kind, saved: c };
      }
    };
    pass(true, true, "blank_match");
    pass(false, true, "ref_link");
    pass(true, false, "blank_match");
    pass(false, false, "differs");
  }
  return out;
}

/**
 * Phase 2: the file against itself. Only rows that phase 1 left as "new" take part.
 * A row is paired with the FIRST earlier row of the same key that has the same reference
 * (blank counts as a reference of its own), so 3 identical rows give 2 -> 1 and 3 -> 1, never 3 -> 2.
 * Rows with the same key but a different reference are not paired, only counted in `info`.
 * `target[i]` = index (in `rows`) of the earlier row, or null. Aligned with `rows`.
 */
export function matchInFile(
  rows: FileTx[],
  phase1: MatchOutcome[],
): { target: (number | null)[]; info: number } {
  const target: (number | null)[] = rows.map(() => null);
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    if (phase1[i].type !== "new") return;
    const g = groups.get(r.key);
    if (g) g.push(i);
    else groups.set(r.key, [i]);
  });

  let info = 0;
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const firstByRef = new Map<string, number>();
    idx.forEach((i, n) => {
      const rk = refKey(rows[i].ref);
      const first = firstByRef.get(rk);
      if (first === undefined) {
        firstByRef.set(rk, i);
        if (n > 0) info++; // same key as an earlier row but a different reference
      } else target[i] = first;
    });
  }
  return { target, info };
}
