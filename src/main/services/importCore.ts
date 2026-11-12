/** Building blocks shared by the accounts import and the transactions import. */
import type { DB } from "../db";
import ExcelJS from "exceljs";
import type { SheetChoice } from "@shared/types";
import { cleanIfsc, isValidIfsc } from "@shared/format";
import {
  COMPARE,
  addSeen,
  clean,
  newSeen,
  same,
  type AccField,
  type SeenMap,
} from "./accountConflicts";
import { createHash } from "crypto";

/** "A/C No." -> "acno" */
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Text such as 1.2E+15: Excel has already lost the digits. */
export const isDamagedText = (text: string) => /^\d(\.\d+)?e\+\d+$/i.test(text);

export const DAMAGED_MSG =
  "Account number damaged by Excel (long number). Format the column as Text, re-enter it and save again";

/** Account numbers are matched exactly: only whitespace and a leading apostrophe are removed. */
export const cleanAccountNo = (s: string | undefined) =>
  (s ?? "").replace(/\s/g, "").replace(/^'/, "").slice(0, 60);

type CoreField = "payee" | "account_no" | "bank" | "branch" | "ifsc";

/** Header variations for the five account fields. Extend this list whenever you meet a new one. */
export const ACCOUNT_SYNONYMS: Record<CoreField, string[]> = {
  payee: [
    "payee",
    "payeename",
    "name",
    "beneficiary",
    "beneficiaryname",
    "nameofpayee",
    "nameofbeneficiary",
    "accountholder",
    "accountholdername",
  ],
  account_no: [
    "acno",
    "accno",
    "accountno",
    "accountnumber",
    "acnumber",
    "bankaccountno",
    "bankacno",
    "beneficiaryaccountno",
    "beneficiaryaccountnumber",
  ],
  bank: ["bank", "bankname", "nameofbank"],
  branch: ["branch", "branchname", "bankbranch"],
  ifsc: ["ifsc", "ifscode", "ifsccode", "ifscno", "ifscnumber"],
};

// ---------- header matching ----------
type NameRow = { key: string; label: string };

/** Active custom columns, optionally of one scope ('account' or 'transaction'). */
function activeCustom(db: DB, scope?: string): NameRow[] {
  return (
    scope
      ? db
          .prepare(
            "SELECT key, label FROM custom_fields WHERE scope = ? AND archived = 0",
          )
          .all(scope)
      : db
          .prepare("SELECT key, label FROM custom_fields WHERE archived = 0")
          .all()
  ) as NameRow[];
}

/** Header -> field the user chose in an earlier import. */
function savedMappings(db: DB): Map<string, string> {
  return new Map(
    (
      db.prepare("SELECT header, field_key FROM import_mappings").all() as {
        header: string;
        field_key: string;
      }[]
    ).map((r) => [r.header, r.field_key]),
  );
}

/** One field per header (or null): saved mapping, then built-in synonym, then custom column label. */
export function autoMapHeaders(
  db: DB,
  headers: string[],
  synonyms: Map<string, string>,
  coreKeys: readonly string[],
  customScope?: string,
): (string | null)[] {
  const custom = activeCustom(db, customScope);
  const customKeys = new Set(custom.map((c) => c.key));
  const byLabel = new Map(custom.map((c) => [norm(c.label), c.key]));
  const saved = savedMappings(db);
  const used = new Set<string>();
  return headers.map((h) => {
    const n = norm(h);
    const key = saved.get(n) ?? synonyms.get(n) ?? byLabel.get(n);
    if (
      !key ||
      used.has(key) ||
      !(coreKeys.includes(key) || customKeys.has(key))
    )
      return null;
    used.add(key);
    return key;
  });
}

/** Header row = the row (within the first 40) matching the most DIFFERENT known column names; titles and banners match nothing. */
export function findHeader(
  db: DB,
  grid: string[][],
  synonyms: Map<string, string>,
  customScope?: string,
): { index: number; score: number } {
  const known = new Map<string, string>();
  for (const c of activeCustom(db, customScope))
    known.set(norm(c.label), c.key);
  for (const [n, k] of synonyms) known.set(n, k);
  for (const [h, k] of savedMappings(db)) known.set(h, k);

  let best = -1,
    bestScore = 0;
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const keys = new Set<string>(); // distinct fields, so a title merged across cells cannot score high
    for (const c of grid[i]) {
      const k = known.get(norm(c));
      if (k) keys.add(k);
    }
    if (keys.size > bestScore) {
      best = i;
      bestScore = keys.size;
    } // earliest row wins a tie
  }
  if (bestScore >= 2) return { index: best, score: bestScore };
  // nothing recognisable: first row with at least 3 different filled cells (skips a title merged across the sheet)
  const i = grid.findIndex((r) => new Set(r.filter(Boolean)).size >= 3);
  return { index: i >= 0 ? i : 0, score: bestScore };
}

/** A row of real data, not column titles: it holds a valid IFSC or a long number (account numbers have 8+ digits). */
export function rowLooksLikeData(cells: string[]): boolean {
  return cells.some((c) => {
    const t = c.replace(/\s/g, "");
    return /^\d{8,}$/.test(t) || (!!t && isValidIfsc(cleanIfsc(t)));
  });
}

/** Header detection with a "no header" answer: known column names win; otherwise a first row that looks like data means there is no header. */
export function detectHeader(
  db: DB,
  grid: string[][],
  synonyms: Map<string, string>,
  customScope?: string,
): { index: number; score: number; hasHeader: boolean } {
  const h = findHeader(db, grid, synonyms, customScope);
  if (h.score >= 2) return { ...h, hasHeader: true };
  return { ...h, hasHeader: !rowLooksLikeData(grid[h.index] ?? []) };
}

// ---------- sheet reading ----------
/** Excel keeps about 15 digits of a number: a 15+ digit value, or text like 1.2E+15, is already damaged. */
export function isDamagedValue(v: unknown, text: string): boolean {
  if (v && typeof v === "object" && !(v instanceof Date) && "result" in v)
    v = (v as { result?: unknown }).result; // formula
  if (typeof v === "number") return Math.abs(v) >= 1e15;
  return isDamagedText(text);
}

/** The cell's raw value as text (dates as YYYY-MM-DD); used for amount and date columns only. */
function rawText(v: unknown, text: string): string {
  if (v && typeof v === "object" && !(v instanceof Date) && "result" in v)
    v = (v as { result?: unknown }).result; // formula
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return String(v);
  return text;
}

/** Displayed text of a cell. ExcelJS's cell.text can throw on odd formula cells, so fall back to the stored result. */
function cellText(cell: ExcelJS.Cell): string {
  try {
    return (cell.text ?? "").trim();
  } catch {
    let v: unknown = cell.value;
    if (v && typeof v === "object" && !(v instanceof Date) && "result" in v)
      v = (v as { result?: unknown }).result;
    return v == null ? "" : String(v).trim();
  }
}

export interface SheetRow {
  n: number; // real Excel row number
  cells: string[]; // as displayed in Excel (keeps leading zeros and long account numbers)
  raws: string[]; // raw values as text: for amount and date columns
  risky: number[]; // columns Excel has already damaged
}

/** Reads the first sheet. Rows that are empty (even if styled) are skipped. */
export async function openWorkbook(
  filePath: string,
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  if (!wb.worksheets.length) throw new Error("No sheet found in file");
  return wb;
}

/** Reads one sheet. Empty rows (even if styled) are skipped. limit > 0 stops after that many rows (used for scoring). */
export function readWorksheet(ws: ExcelJS.Worksheet, limit = 0): SheetRow[] {
  const width = ws.columnCount;
  const rows: SheetRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (limit && rows.length >= limit) return;
    const cells: string[] = [],
      raws: string[] = [],
      risky: number[] = [];
    for (let c = 1; c <= width; c++) {
      const cell = row.getCell(c);
      const text = cellText(cell);
      cells.push(text);
      raws.push(rawText(cell.value, text));
      if (isDamagedValue(cell.value, text)) risky.push(c - 1);
    }
    if (cells.some((x) => x !== "")) rows.push({ n, cells, raws, risky });
  });
  return rows;
}

/** Reads the first sheet (kept for the accounts import until it gets the sheet picker). */
export async function readSheet(filePath: string): Promise<SheetRow[]> {
  const wb = await openWorkbook(filePath);
  const rows = readWorksheet(wb.worksheets[0]);
  if (!rows.length) throw new Error("The sheet is empty");
  return rows;
}

/** All sheets: visible ones in workbook order, then hidden ones. Exactly one is recommended (score >= 2). */
export function listSheets(
  db: DB,
  wb: ExcelJS.Workbook,
  synonyms: Map<string, string>,
  customScope?: string,
): SheetChoice[] {
  const all = wb.worksheets.map((ws) => {
    const grid = readWorksheet(ws, 40).map((r) => r.cells);
    return {
      name: ws.name,
      hidden: ws.state !== "visible",
      score: grid.length
        ? findHeader(db, grid, synonyms, customScope).score
        : 0,
    };
  });
  const ordered = [
    ...all.filter((s) => !s.hidden),
    ...all.filter((s) => s.hidden),
  ];
  // Hidden sheets are recommended only when no visible sheet has recognisable headers (score >= 2).
  const visible = ordered.filter((s) => !s.hidden);
  const pool = visible.some((s) => s.score >= 2) ? visible : ordered;
  const top = Math.max(0, ...pool.map((s) => s.score));
  const best = top >= 2 ? pool.find((s) => s.score === top) : undefined;
  return ordered.map((s) => ({ ...s, recommended: s === best }));
}

// ---------- accounts and saved mappings ----------

/** Remembers which field each header was mapped to, so the next import maps itself. Call inside the import's DB transaction. */
export function saveHeaderMappings(
  db: DB,
  headers: string[],
  mapping: (string | null)[],
): void {
  const q = db.prepare(
    "INSERT OR REPLACE INTO import_mappings(header, field_key) VALUES (?, ?)",
  );
  mapping.forEach((k, i) => {
    if (k) q.run(norm(headers[i]), k);
  });
}

/** The two account writes both imports use. Call inside the import's DB transaction. */
export function accountWriter(db: DB) {
  const ins = db.prepare(
    `INSERT INTO accounts (id, payee, bank, branch, account_no, ifsc, remarks, in_master, extra, created_at, updated_at, batch_id)
     VALUES (@id, @payee, @bank, @branch, @account_no, @ifsc, @remarks, @in_master, @extra, @now, @now, @batch)`,
  );
  const upd = db.prepare(
    "UPDATE accounts SET payee=@payee, bank=@bank, branch=@branch, ifsc=@ifsc, remarks=@remarks, in_master=@in_master, extra=@extra, updated_at=@now WHERE id=@id",
  );
  return {
    /** New account. Needs id, payee, bank, branch, account_no, ifsc, remarks, in_master (0|1), extra (JSON text), now, batch (number|null). */
    insert: (a: Record<string, unknown>) => void ins.run(a),
    /** Changes details and in_master. Needs id, payee, bank, branch, ifsc, remarks, in_master (0|1), extra (JSON text), now. */
    update: (a: Record<string, unknown>) => void upd.run(a),
  };
}

// ---------- shared account index, reading and grouping (both imports) ----------
export interface StoredAccount {
  id: string;
  payee: string;
  bank: string;
  branch: string;
  account_no: string;
  ifsc: string;
  remarks: string;
  in_master: number;
  extra: string;
  created_at: string;
}
export interface AccountIndex {
  byNo: Map<string, StoredAccount>; // exact account number -> best stored account
  byNameIfsc: Map<string, StoredAccount>; // name|IFSC -> best stored account (one-offs included)
}
export const nameIfscKey = (payee: string, ifsc: string) =>
  clean(payee).toLowerCase() + "|" + ifsc;

/** Every stored account, loaded once. Best = a master account over a one-off, then the oldest. */
export function loadAccountIndex(db: DB): AccountIndex {
  const rows = db
    .prepare(
      "SELECT id, payee, bank, branch, account_no, ifsc, remarks, in_master, extra, created_at FROM accounts WHERE account_no <> ''",
    )
    .all() as StoredAccount[];
  const better = (a: StoredAccount, b: StoredAccount) =>
    a.in_master !== b.in_master
      ? a.in_master > b.in_master
      : a.created_at < b.created_at;
  const byNo = new Map<string, StoredAccount>();
  for (const a of rows) {
    const cur = byNo.get(a.account_no);
    if (!cur || better(a, cur)) byNo.set(a.account_no, a);
  }
  const byNameIfsc = new Map<string, StoredAccount>();
  for (const a of byNo.values()) {
    if (!a.ifsc) continue;
    const k = nameIfscKey(a.payee, a.ifsc);
    const cur = byNameIfsc.get(k);
    if (!cur || better(a, cur)) byNameIfsc.set(k, a);
  }
  return { byNo, byNameIfsc };
}

export interface AccountFields {
  payee: string;
  bank: string;
  branch: string;
  account_no: string;
  ifsc: string;
  remarks: string;
}
export interface AccountRead {
  fields: AccountFields;
  noAccount: boolean;
  damaged: boolean; // the account number was already damaged by Excel
  badIfsc: boolean;
}

/** Reads the five account fields from one row's values, cleaned the same way in every import. `risky` = Excel damaged the account-number cell. */
export function readAccountFields(
  v: Record<string, string>,
  risky: boolean,
): AccountRead {
  const fields: AccountFields = {
    payee: clean(v.payee),
    bank: clean(v.bank),
    branch: clean(v.branch),
    account_no: cleanAccountNo(v.account_no),
    ifsc: cleanIfsc(v.ifsc ?? ""),
    remarks: clean(v.remarks, 500),
  };
  return {
    fields,
    noAccount: !fields.account_no,
    damaged: !!fields.account_no && (risky || isDamagedText(fields.account_no)),
    badIfsc: !!fields.ifsc && !isValidIfsc(fields.ifsc),
  };
}

export interface AccountGroup {
  account_no: string;
  values: Record<AccField | "remarks", string>;
  extra: Record<string, string>;
  rows: number[];
  conflicts: string[]; // "Bank: A / B" where rows of one account disagree
  seen: SeenMap; // field -> value -> Excel rows
}
export const newGroup = (account_no: string): AccountGroup => ({
  account_no,
  values: { payee: "", bank: "", branch: "", ifsc: "", remarks: "" },
  extra: {},
  rows: [],
  conflicts: [],
  seen: newSeen(),
});

/** Adds one row to its account's group: the first non-empty value wins, disagreements are recorded. */
export function addRowToGroup(
  g: AccountGroup,
  f: AccountFields,
  row: number,
): void {
  g.rows.push(row);
  for (const [field, label] of COMPARE) {
    const val = f[field];
    if (!val) continue;
    addSeen(g.seen, field, val, row);
    if (!g.values[field]) g.values[field] = val;
    else if (!same(g.values[field], val)) {
      const msg = `${label}: ${g.values[field]} / ${val}`;
      if (!g.conflicts.includes(msg)) g.conflicts.push(msg);
    }
  }
  if (!g.values.remarks) g.values.remarks = f.remarks;
}

/**
 * Look-alike check for NEW accounts (call it once per new account, in file order):
 * same name + IFSC as a stored account (one-offs included) or as an earlier new account in the file.
 */
export function twinChecker(index: AccountIndex) {
  const earlier = new Map<string, string>(); // name|IFSC -> first new account number
  return (
    payee: string,
    ifsc: string,
    accountNo: string,
  ): { stored?: StoredAccount; earlierNo?: string } | null => {
    if (!payee || !ifsc) return null;
    const k = nameIfscKey(payee, ifsc);
    const stored = index.byNameIfsc.get(k);
    const earlierNo = earlier.get(k);
    if (!earlierNo) earlier.set(k, accountNo);
    return stored || earlierNo ? { stored, earlierNo } : null;
  };
}

// ---------- file fingerprint (both imports) ----------
/** Same data rows give the same fingerprint, whatever the spacing, trailing empty cells or row order. */
export function fingerprintRows(rows: string[][]): string {
  const lines: string[] = [];
  for (const r of rows) {
    const cells = r.map((c) => clean(c, 10_000));
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (cells.length) lines.push(cells.join("\u001f"));
  }
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export interface PriorImport {
  on: string; // ISO time of the earlier import
  file: string;
}

/** The latest import of this kind with the same fingerprint that has not been undone, or null. */
export function findPriorImport(
  db: DB,
  kind: "tx" | "master",
  hash: string,
): PriorImport | null {
  const r = db
    .prepare(
      "SELECT created_at, file_name FROM import_batches WHERE kind = ? AND file_hash = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get(kind, hash) as { created_at: string; file_name: string } | undefined;
  return r ? { on: r.created_at, file: r.file_name } : null;
}
