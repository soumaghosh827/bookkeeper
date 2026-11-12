import type { DB } from "../db";

export const REF_MAX = 100;

/** Reference as typed: trimmed and capped. */
export const cleanRef = (s: unknown): string =>
  String(s ?? "")
    .trim()
    .slice(0, REF_MAX);

/** Matching form: lower-case, all whitespace removed. */
export const refKey = (s: unknown): string =>
  cleanRef(s).toLowerCase().replace(/\s+/g, "");

/** All references of one transaction as one display text, e.g. "REF-101, REF-205". */
export const refsText = (refs: string[]): string => refs.join(", ");

/**
 * Links a reference to a transaction.
 * Blank, or already linked (ignoring case and spaces) -> nothing happens.
 * Returns true only if a new row was added.
 */
export function addReference(
  db: DB,
  txUid: string,
  refNo: unknown,
  opts: {
    batchId?: number | null;
    reportId?: number | null;
    now?: string;
  } = {},
): boolean {
  const ref = cleanRef(refNo);
  const key = refKey(ref);
  if (!key) return false;
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO transaction_references
         (transaction_id, ref_no, ref_key, report_id, batch_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      txUid,
      ref,
      key,
      opts.reportId ?? null,
      opts.batchId ?? null,
      opts.now ?? new Date().toISOString(),
    );
  return r.changes > 0;
}

/** References of one transaction, in the order they were added. */
export function getReferences(db: DB, txUid: string): string[] {
  return (
    db
      .prepare(
        "SELECT ref_no FROM transaction_references WHERE transaction_id = ? ORDER BY id",
      )
      .all(txUid) as { ref_no: string }[]
  ).map((r) => r.ref_no);
}

/** References for many transactions at once (chunked to stay under SQLite's variable limit). */
export function getReferencesMap(
  db: DB,
  uids: string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < uids.length; i += 500) {
    const part = uids.slice(i, i + 500);
    const rows = db
      .prepare(
        `SELECT transaction_id AS uid, ref_no FROM transaction_references
          WHERE transaction_id IN (${part.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...part) as { uid: string; ref_no: string }[];
    for (const r of rows) {
      const list = out.get(r.uid);
      if (list) list.push(r.ref_no);
      else out.set(r.uid, [r.ref_no]);
    }
  }
  return out;
}

/** Splits typed text such as "REF-101, REF-205" into a clean list (blanks dropped, duplicates ignoring case/spaces dropped). */
export function parseRefs(text: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(text ?? "").split(",")) {
    const r = cleanRef(part);
    const k = refKey(r);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/** Makes a transaction's references exactly `refs`. Existing links that stay keep their report/batch tags. */
export function setReferences(
  db: DB,
  txUid: string,
  refs: string[],
  now = new Date().toISOString(),
): void {
  const want = new Map(refs.map((r) => [refKey(r), cleanRef(r)]));
  const have = db
    .prepare(
      "SELECT id, ref_key FROM transaction_references WHERE transaction_id = ?",
    )
    .all(txUid) as { id: number; ref_key: string }[];
  for (const h of have)
    if (!want.has(h.ref_key))
      db.prepare("DELETE FROM transaction_references WHERE id = ?").run(h.id);
  for (const [key, ref] of want) {
    addReference(db, txUid, ref, { now });
    db.prepare(
      "UPDATE transaction_references SET ref_no = ? WHERE transaction_id = ? AND ref_key = ? AND ref_no <> ?",
    ).run(ref, txUid, key, ref);
  }
}
