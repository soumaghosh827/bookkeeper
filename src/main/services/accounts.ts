import { randomUUID } from "crypto";
import type { DB } from "../db";
import {
  ACCOUNT_KEYS,
  SEARCH_KEYS,
  isCustomKey,
  type Account,
  type AccountInput,
  type ConfirmKind,
  type Confirmations,
  type GridPage,
  type GridQuery,
  type Result,
  type SearchKey,
} from "@shared/types";
import { cleanIfsc, isValidIfsc } from "@shared/format";
import { FieldError } from "./errors";
import { audit } from "./audit";
import { buildGrid, esc, type ColDef } from "./gridQuery";

const COLS: Record<string, ColDef> = Object.fromEntries(
  ACCOUNT_KEYS.map((k) => [k, { expr: k }]),
);
const HAY = `payee||' '||bank||' '||branch||' '||account_no||' '||ifsc||' '||remarks`;
const toAccount = (r: any): Account => ({ ...r, in_master: !!r.in_master });

export const getAccount = (db: DB, id: string) => {
  const r = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  return r ? toAccount(r) : null;
};

export function listAccounts(db: DB, q: GridQuery): GridPage<Account> {
  const b = buildGrid(
    COLS,
    "extra",
    HAY,
    [`in_master = ${q.oneOff ? 0 : 1}`],
    q,
  );
  const order = (b.order ? b.order + ", " : "") + "created_at DESC, id";
  const rows = db
    .prepare(
      `SELECT * FROM accounts WHERE ${b.where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(
      ...b.params,
      ...b.orderParams,
      Math.min(q.limit, 500),
      q.offset,
    ) as any[];
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM accounts WHERE ${b.where}`)
    .get(...b.params) as { total: number };
  return { rows: rows.map(toAccount), total };
}

/** Per-field search: the text is matched against THAT column only. Prefix matches first, then most used. */
export function searchAccounts(
  db: DB,
  field: SearchKey,
  text: string,
  limit = 8,
): Account[] {
  if (!(SEARCH_KEYS as readonly string[]).includes(field)) return [];
  const t = String(text).trim().toLowerCase();
  if (!t) {
    // empty text (Alt+Down): the most used accounts for this field
    return (
      db
        .prepare(
          `SELECT * FROM accounts WHERE in_master = 1 AND ${field} <> '' ORDER BY use_count DESC, last_used_at DESC, payee COLLATE NOCASE LIMIT ?`,
        )
        .all(limit) as any[]
    ).map(toAccount);
  }
  return (
    db
      .prepare(
        `SELECT * FROM accounts WHERE in_master = 1 AND lower(${field}) LIKE ? ESCAPE '\\'
     ORDER BY (lower(${field}) LIKE ? ESCAPE '\\') DESC, use_count DESC, last_used_at DESC, payee COLLATE NOCASE LIMIT ?`,
      )
      .all(`%${esc(t)}%`, `${esc(t)}%`, limit) as any[]
  ).map(toAccount);
}

const clean = (a: Partial<AccountInput>): Partial<AccountInput> => {
  const o: Partial<AccountInput> = {};
  for (const k of ACCOUNT_KEYS)
    if (a[k] !== undefined) o[k] = String(a[k]).trim().slice(0, 200);
  if (o.ifsc !== undefined) o.ifsc = cleanIfsc(o.ifsc);
  if (o.account_no !== undefined)
    o.account_no = o.account_no.replace(/\s/g, "");
  return o;
};
function validate(a: AccountInput) {
  if (!a.payee) throw new FieldError("Beneficiary name is required", "payee");
  if (!a.account_no)
    throw new FieldError("Account number is required", "account_no");
  if (a.ifsc && !isValidIfsc(a.ifsc))
    throw new FieldError("Invalid IFSC code", "ifsc");
}
const cleanExtra = (e?: Record<string, string>) => {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(e ?? {}))
    if (isCustomKey(k) && String(v).trim())
      o[k] = String(v).trim().slice(0, 500);
  return o;
};

/** Same account number = probable duplicate (strong warning). Same payee + IFSC = soft warning. */
export function findSimilar(
  db: DB,
  a: { payee: string; ifsc: string; account_no: string },
  excludeId = "",
) {
  const dup = a.account_no
    ? (db
        .prepare(
          "SELECT * FROM accounts WHERE in_master = 1 AND account_no = ? AND id <> ? LIMIT 3",
        )
        .all(a.account_no, excludeId) as any[])
    : [];
  const similar = a.ifsc
    ? (db
        .prepare(
          "SELECT * FROM accounts WHERE in_master = 1 AND lower(payee) = lower(?) AND ifsc = ? AND account_no <> ? AND id <> ? LIMIT 3",
        )
        .all(a.payee, a.ifsc, a.account_no, excludeId) as any[])
    : [];
  return { dup: dup.map(toAccount), similar: similar.map(toAccount) };
}

export function needsFor(
  db: DB,
  a: { payee: string; ifsc: string; account_no: string },
  excludeId: string,
  c: Confirmations,
) {
  const { dup, similar } = findSimilar(db, a, excludeId);
  const needs: ConfirmKind[] = [];
  const existing: Account[] = [];
  if (dup.length && !c.duplicateAccount) {
    needs.push("duplicateAccount");
    existing.push(...dup);
  }
  if (similar.length && !c.similarAccount) {
    needs.push("similarAccount");
    existing.push(...similar);
  }
  return { needs, existing };
}

export function insertAccount(
  db: DB,
  a: AccountInput,
  inMaster: boolean,
): string {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO accounts (id, payee, bank, branch, account_no, ifsc, remarks, in_master, extra, created_at, updated_at)
     VALUES (@id, @payee, @bank, @branch, @account_no, @ifsc, @remarks, @in_master, @extra, @now, @now)`,
  ).run({
    ...a,
    id,
    in_master: inMaster ? 1 : 0,
    extra: JSON.stringify(cleanExtra(a.extra)),
    now,
  });
  audit(db, "accounts", id, "create", {
    payee: [null, a.payee],
    account_no: [null, a.account_no],
  });
  return id;
}

export function createAccount(
  db: DB,
  input: AccountInput,
  c: Confirmations = {},
): Result<Account> {
  const a = {
    payee: "",
    bank: "",
    branch: "",
    account_no: "",
    ifsc: "",
    remarks: "",
    ...clean(input),
    extra: input.extra,
  } as AccountInput;
  validate(a);
  const { needs, existing } = needsFor(db, a, "", c);
  if (needs.length) return { ok: false, needs, existing };
  return { ok: true, data: getAccount(db, insertAccount(db, a, true))! };
}

export function updateAccount(
  db: DB,
  id: string,
  changes: Partial<AccountInput>,
  c: Confirmations = {},
): Result<Account> {
  const cur = getAccount(db, id);
  if (!cur) return { ok: false, error: "Account not found" };
  const ch = clean(changes);
  const diff: Record<string, [string, string]> = {};
  for (const k of ACCOUNT_KEYS)
    if (ch[k] !== undefined && ch[k] !== cur[k]) diff[k] = [cur[k], ch[k]!];
  let extra = JSON.parse(cur.extra || "{}") as Record<string, string>;
  if (changes.extra) {
    for (const [k, v] of Object.entries(changes.extra)) {
      if (!isCustomKey(k)) continue;
      const nv = String(v).trim().slice(0, 500);
      if ((extra[k] ?? "") !== nv) {
        diff[k] = [extra[k] ?? "", nv];
        nv ? (extra[k] = nv) : delete extra[k];
      }
    }
  }
  if (!Object.keys(diff).length) return { ok: true, data: cur };

  const merged = { ...cur, ...ch } as AccountInput & Account;
  validate(merged);
  if (cur.in_master && (diff.payee || diff.ifsc || diff.account_no)) {
    const { needs, existing } = needsFor(db, merged, id, c);
    if (needs.length) return { ok: false, needs, existing };
  }
  db.prepare(
    `UPDATE accounts SET payee=@payee, bank=@bank, branch=@branch, account_no=@account_no, ifsc=@ifsc, remarks=@remarks,
     extra=@extra, updated_at=@now WHERE id=@id`,
  ).run({
    ...merged,
    id,
    extra: JSON.stringify(extra),
    now: new Date().toISOString(),
  });
  audit(db, "accounts", id, "update", diff);
  return { ok: true, data: getAccount(db, id)! };
}

/** Keeps the "most used" ranking and last-used info current. Call after any transaction create/delete. */
export function refreshAccountStats(db: DB, id: string) {
  db.prepare(
    `UPDATE accounts SET
       use_count = (SELECT COUNT(*) FROM transactions WHERE account_id = @id AND deleted_at IS NULL),
       last_used_at = (SELECT MAX(entry_date) FROM transactions WHERE account_id = @id AND deleted_at IS NULL),
       last_amount_paise = (SELECT amount_paise FROM transactions WHERE account_id = @id AND deleted_at IS NULL ORDER BY entry_date DESC, created_at DESC LIMIT 1)
     WHERE id = @id`,
  ).run({ id });
}
