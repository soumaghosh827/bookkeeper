import { randomUUID } from "crypto";
import type { DB } from "../db";
import {
  isCustomKey,
  type ConfirmKind,
  type Confirmations,
  type GridPage,
  type GridQuery,
  type Result,
  type TxChanges,
  type TxCreate,
  type TxHistoryEntry,
  type TxRow,
} from "@shared/types";
import { HIGH_VALUE_PAISE, canCorrectFreely, canDelete } from "@shared/rules";
import { parseDate } from "@shared/format";
import { FieldError } from "./errors";
import { audit } from "./audit";
import { buildGrid, type ColDef } from "./gridQuery";
import {
  findSimilar,
  getAccount,
  insertAccount,
  needsFor,
  refreshAccountStats,
} from "./accounts";
import { addToPreview, removeFromPreview } from "./preview";

const RC = "(SELECT COUNT(*) FROM report_items r WHERE r.tx_uid = t.uid)";
const COLS: Record<string, ColDef> = {
  reference_no: { expr: "t.reference_no" },
  entry_date: { expr: "t.entry_date", kind: "date" },
  payee: { expr: "a.payee" },
  bank: { expr: "a.bank" },
  branch: { expr: "a.branch" },
  account_no: { expr: "a.account_no" },
  ifsc: { expr: "a.ifsc" },
  amount_paise: { expr: "t.amount_paise", kind: "amount" },
  utr: { expr: "t.utr" },
  notes: { expr: "t.notes" },
  report_count: { expr: RC, kind: "count" },
};
const HAY = `a.payee||' '||a.bank||' '||a.branch||' '||a.account_no||' '||a.ifsc||' '||t.reference_no||' '||t.utr||' '||t.notes||' '||t.extra`;
const SELECT = `SELECT t.*, a.payee, a.bank, a.branch, a.account_no, a.ifsc, ${RC} AS report_count,
  EXISTS(SELECT 1 FROM preview_items p WHERE p.tx_uid = t.uid) AS in_preview
  FROM transactions t JOIN accounts a ON a.id = t.account_id`;

export const getRow = (db: DB, uid: string) =>
  db.prepare(`${SELECT} WHERE t.uid = ?`).get(uid) as TxRow | undefined;

export function getRowsByUids(db: DB, uids: string[]): TxRow[] {
  const out: TxRow[] = [];
  for (let i = 0; i < uids.length; i += 500) {
    const part = uids.slice(i, i + 500);
    out.push(
      ...(db
        .prepare(
          `${SELECT} WHERE t.deleted_at IS NULL AND t.uid IN (${part.map(() => "?").join(",")})`,
        )
        .all(...part) as TxRow[]),
    );
  }
  const by = new Map(out.map((r) => [r.uid, r]));
  return uids.map((u) => by.get(u)).filter(Boolean) as TxRow[]; // keeps the caller's order
}

export function listTransactions(db: DB, q: GridQuery): GridPage<TxRow> {
  const b = buildGrid(COLS, "t.extra", HAY, ["t.deleted_at IS NULL"], q);
  const order = (b.order ? b.order + ", " : "") + "t.created_at DESC, t.uid";
  const limit = q.limit < 0 ? -1 : Math.min(q.limit, 500);
  const rows = db
    .prepare(`${SELECT} WHERE ${b.where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...b.params, ...b.orderParams, limit, q.offset) as TxRow[];
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(t.amount_paise), 0) AS sum FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE ${b.where}`,
    )
    .get(...b.params) as { total: number; sum: number };
  return { rows, total: agg.total, sumPaise: agg.sum };
}

const cleanExtra = (e?: Record<string, string>) => {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(e ?? {}))
    if (isCustomKey(k) && String(v).trim())
      o[k] = String(v).trim().slice(0, 500);
  return o;
};
const checkAmount = (n: unknown) => {
  if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 1e13)
    throw new FieldError("Invalid amount", "amount_paise");
  return n as number;
};
const checkDate = (s: unknown) => {
  const iso = typeof s === "string" ? parseDate(s) : null;
  if (!iso) throw new FieldError("Invalid date", "entry_date");
  return iso;
};
const isDuplicate = (
  db: DB,
  accountId: string,
  amount: number,
  date: string,
  ref: string,
  excludeUid = "",
) =>
  !!db
    .prepare(
      "SELECT 1 FROM transactions WHERE account_id=? AND amount_paise=? AND entry_date=? AND reference_no=? AND deleted_at IS NULL AND uid<>? LIMIT 1",
    )
    .get(accountId, amount, date, ref, excludeUid);

function amountNeeds(amount: number, c: Confirmations): ConfirmKind[] {
  const n: ConfirmKind[] = [];
  if (amount === 0 && !c.zero) n.push("zero");
  if (amount >= HIGH_VALUE_PAISE && !c.highValue) n.push("highValue");
  return n;
}

export function createTransaction(
  db: DB,
  input: TxCreate,
  c: Confirmations = {},
): Result<TxRow> {
  const amount = checkAmount(input.amount_paise);
  const date = checkDate(input.entry_date);
  const ref = String(input.reference_no ?? "")
    .trim()
    .slice(0, 100);
  const needs: ConfirmKind[] = amountNeeds(amount, c);
  let existing: import("@shared/types").Account[] = [];
  let accountId = input.account_id ?? null;
  let newAcc: ReturnType<typeof prepareNewAccount> | null = null;

  if (accountId) {
    const a = getAccount(db, accountId);
    if (!a) return { ok: false, error: "Account not found" };
    if (isDuplicate(db, accountId, amount, date, ref) && !c.duplicate)
      needs.push("duplicate");
  } else if (input.account) {
    newAcc = prepareNewAccount(input.account);
    if (input.account.save_to_master) {
      const n = needsFor(db, newAcc.a, "", c);
      needs.push(...n.needs);
      existing = n.existing;
    }
  } else return { ok: false, error: "Choose a beneficiary", field: "payee" };

  if (needs.length) return { ok: false, needs, existing };

  const uid = randomUUID(),
    now = new Date().toISOString();
  db.transaction(() => {
    if (newAcc)
      accountId = insertAccount(db, newAcc.a, !!input.account!.save_to_master);
    db.prepare(
      `INSERT INTO transactions (uid, account_id, amount_paise, reference_no, utr, notes, entry_date, extra, created_at, updated_at)
       VALUES (@uid, @account_id, @amount, @ref, @utr, @notes, @date, @extra, @now, @now)`,
    ).run({
      uid,
      account_id: accountId,
      amount,
      ref,
      utr: String(input.utr ?? "").trim(),
      notes: String(input.notes ?? "").trim(),
      date,
      extra: JSON.stringify(cleanExtra(input.extra)),
      now,
    });
    audit(db, "transactions", uid, "create", {
      amount_paise: [null, amount],
      entry_date: [null, date],
    });
    refreshAccountStats(db, accountId!);
    if (input.add_to_preview !== false) addToPreview(db, [uid]);
  })();
  return { ok: true, data: getRow(db, uid)! };
}

function prepareNewAccount(a: NonNullable<TxCreate["account"]>) {
  // Same cleaning/validation as the master screen, via a throw-away validation of the fields we need.
  const payee = String(a.payee ?? "").trim();
  if (!payee) throw new FieldError("Beneficiary name is required", "payee");
  const ifsc = String(a.ifsc ?? "")
    .replace(/\s/g, "")
    .toUpperCase();
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc))
    throw new FieldError("Invalid IFSC code", "ifsc");
  return {
    a: {
      payee,
      ifsc,
      bank: String(a.bank ?? "").trim(),
      branch: String(a.branch ?? "").trim(),
      account_no: String(a.account_no ?? "").replace(/\s/g, ""),
      remarks: String(a.remarks ?? "").trim(),
    },
  };
}

/** Only these can change here. Beneficiary / account / bank / branch / IFSC live in master and are edited there. */
function applyChanges(
  db: DB,
  uid: string,
  ch: TxChanges,
  c: Confirmations = {},
  reason: string | null = null,
): Result<TxRow> {
  const cur = getRow(db, uid);
  if (!cur) return { ok: false, error: "Transaction not found" };
  const diff: Record<string, [unknown, unknown]> = {};
  const next = {
    amount_paise: cur.amount_paise,
    entry_date: cur.entry_date,
    reference_no: cur.reference_no,
    utr: cur.utr,
    notes: cur.notes,
  };

  if (ch.amount_paise !== undefined)
    next.amount_paise = checkAmount(ch.amount_paise);
  if (ch.entry_date !== undefined) next.entry_date = checkDate(ch.entry_date);
  if (ch.reference_no !== undefined)
    next.reference_no = String(ch.reference_no).trim().slice(0, 100);
  if (ch.utr !== undefined) next.utr = String(ch.utr).trim().slice(0, 100);
  if (ch.notes !== undefined)
    next.notes = String(ch.notes).trim().slice(0, 500);
  for (const k of Object.keys(next) as (keyof typeof next)[])
    if (next[k] !== cur[k]) diff[k] = [cur[k], next[k]];

  const extra = JSON.parse(cur.extra || "{}") as Record<string, string>;
  for (const [k, v] of Object.entries(ch.extra ?? {})) {
    if (!isCustomKey(k)) continue;
    const nv = String(v).trim().slice(0, 500);
    if ((extra[k] ?? "") !== nv) {
      diff[k] = [extra[k] ?? "", nv];
      nv ? (extra[k] = nv) : delete extra[k];
    }
  }
  if (!Object.keys(diff).length) return { ok: true, data: cur };

  const needs: ConfirmKind[] = diff.amount_paise
    ? amountNeeds(next.amount_paise, c)
    : [];
  if (
    (diff.amount_paise || diff.entry_date || diff.reference_no) &&
    !c.duplicate &&
    isDuplicate(
      db,
      cur.account_id,
      next.amount_paise,
      next.entry_date,
      next.reference_no,
      uid,
    )
  )
    needs.push("duplicate");
  if (needs.length) return { ok: false, needs };

  db.transaction(() => {
    db.prepare(
      "UPDATE transactions SET amount_paise=@amount_paise, entry_date=@entry_date, reference_no=@reference_no, utr=@utr, notes=@notes, extra=@extra, updated_at=@now WHERE uid=@uid",
    ).run({
      ...next,
      extra: JSON.stringify(extra),
      now: new Date().toISOString(),
      uid,
    });
    audit(db, "transactions", uid, "update", diff, reason);
    refreshAccountStats(db, cur.account_id);
  })();
  return { ok: true, data: getRow(db, uid)! };
}

const LOCKED_KEYS = ["amount_paise", "entry_date", "reference_no"] as const;

/** Grid edits: UTR, notes and custom columns only. Amount, date and reference go through correctTransaction. */
export function updateTransaction(
  db: DB,
  uid: string,
  ch: TxChanges,
  c: Confirmations = {},
): Result<TxRow> {
  if (LOCKED_KEYS.some((k) => ch[k] !== undefined))
    return {
      ok: false,
      error:
        'Amount, date and reference can only be changed through "Correct this transaction"',
    };
  return applyChanges(db, uid, ch, c);
}

export interface CorrectAuth {
  password?: string;
  reason?: string;
}

/** Corrects amount / date / reference. Free within 48h of creation; after that it needs the password and a reason. */
export function correctTransaction(
  db: DB,
  uid: string,
  ch: TxChanges,
  c: Confirmations,
  auth: CorrectAuth,
  verify: (password: string) => boolean,
): Result<TxRow> {
  const cur = getRow(db, uid);
  if (!cur) return { ok: false, error: "Transaction not found" };
  let reason: string | null = null;
  if (!canCorrectFreely(cur.created_at)) {
    reason = String(auth.reason ?? "")
      .trim()
      .slice(0, 300);
    if (!reason) return { ok: false, error: "Reason required" };
    if (!verify(String(auth.password ?? "")))
      return { ok: false, error: "Wrong password" };
  }
  const only: TxChanges = {
    amount_paise: ch.amount_paise,
    entry_date: ch.entry_date,
    reference_no: ch.reference_no,
  };
  return applyChanges(db, uid, only, c, reason);
}

/** Soft delete, allowed only inside the delete window (rules.ts). The UI asks for confirmation first. */
export function removeTransaction(db: DB, uid: string): Result {
  const cur = getRow(db, uid);
  if (!cur) return { ok: false, error: "Transaction not found" };
  if (!canDelete(cur.created_at))
    return {
      ok: false,
      error:
        "Locked: transactions can only be deleted within 2 days of creation",
    };
  db.transaction(() => {
    db.prepare(
      "UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE uid = ?",
    ).run(new Date().toISOString(), new Date().toISOString(), uid);
    removeFromPreview(db, uid);
    audit(db, "transactions", uid, "delete", {
      amount_paise: [cur.amount_paise, null],
      payee: [cur.payee, null],
    });
    refreshAccountStats(db, cur.account_id);
  })();
  return { ok: true };
}

/** Audit trail of one transaction, newest first. Uses the row_id index, so it stays fast on large logs. */
export function txHistory(db: DB, uid: string): TxHistoryEntry[] {
  const rows = db
    .prepare(
      "SELECT at, action, changes, reason FROM audit_log WHERE table_name = 'transactions' AND row_id = ? ORDER BY id DESC",
    )
    .all(uid) as {
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

export { findSimilar };
