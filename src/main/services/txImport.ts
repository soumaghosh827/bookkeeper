// Transactions Excel import, step 2: load the file and ANALYSE it. Nothing here writes to the database.
// The commit and undo steps (next files) read the result through getPlan().
import ExcelJS from "exceljs";
import { randomUUID } from "crypto";
import { audit } from "./audit";
import { refreshAccountStats } from "./accounts";
import type { DB } from "../db";
import {
  cleanIfsc,
  formatPaise,
  isValidIfsc,
  parseDate,
  todayIso,
} from "@shared/format";
import { HIGH_VALUE_PAISE } from "@shared/rules";

export const TX_IMPORT_KEYS = [
  "payee",
  "account_no",
  "bank",
  "branch",
  "ifsc",
  "remarks",
  "reference_no",
  "entry_date",
  "amount_paise",
  "utr",
  "notes",
] as const;
const KEYS: readonly string[] = TX_IMPORT_KEYS;
const REQUIRED: [string, string][] = [
  ["payee", "Beneficiary"],
  ["account_no", "Account number"],
  ["amount_paise", "Amount"],
];
const COMPARE = [
  ["payee", "Beneficiary"],
  ["bank", "Bank"],
  ["branch", "Branch"],
  ["ifsc", "IFSC"],
] as const;

// ---------- types (moved to shared/types.ts when the UI is wired up) ----------
export interface TxImportFileInfo {
  source: string;
  headers: string[];
  rowCount: number;
  headerRow: number; // Excel row the headers were found in; rows above it are titles or blanks
  mapping: (string | null)[];
}
export interface Rejected {
  row: number;
  reason: string;
  values: Record<string, string>;
}
export type ExceptionKind =
  | "master_diff"
  | "file_conflict"
  | "zero_amount"
  | "high_value";

export type AccField = "payee" | "bank" | "branch" | "ifsc";
export interface FieldCandidate {
  value: string;
  source: "file" | "master";
  rows: number[]; // Excel rows with this value (empty for master)
  count: number;
}
export interface FieldConflict {
  field: AccField;
  label: string;
  candidates: FieldCandidate[];
  defaultValue: string; // what happens today if the user does nothing
  current: string; // value stored in the database today ("" for a new account or an empty field)
}
export interface TxException {
  id: string; // used by the commit step for per-item decisions
  kind: ExceptionKind;
  rows: number[]; // Excel row numbers (first 20)
  rowCount: number;
  account_no: string;
  payee: string;
  detail: string;
  fields?: FieldConflict[]; // only for file_conflict / master_diff
}
export interface TxImportAnalysis {
  total: number;
  dateMode: "column" | "today"; // 'today' = no date column mapped, every row gets today's date
  accounts: { new: number; existing: number; oneOffExisting: number };
  transactions: { fresh: number; exists: number; twinGroups: number };
  rejectedCount: number;
  rejected: Rejected[]; // first 200
  exceptions: TxException[];
}
export interface PlannedAccount {
  account_no: string;
  values: {
    payee: string;
    bank: string;
    branch: string;
    ifsc: string;
    remarks: string;
  };
  extra: Record<string, string>;
  existingId: string | null;
  existingInMaster: boolean;
  rows: number[];
  conflicts: string[];
  seen: Record<AccField, Map<string, number[]>>; // field -> value -> Excel rows
}
export interface PlannedTx {
  row: number;
  account_no: string;
  amount_paise: number;
  entry_date: string;
  reference_no: string;
  utr: string;
  notes: string;
  extra: Record<string, string>;
  status: "fresh" | "exists";
  flags: string[]; // ids of exceptions that need a decision first
}
export interface TxImportPlan {
  source: string;
  headers: string[];
  mapping: (string | null)[];
  accounts: Map<string, PlannedAccount>;
  txs: PlannedTx[];
  exceptions: TxException[];
  rejected: Rejected[];
}

// ---------- helpers ----------
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const clean = (s: string | undefined, max = 200) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const same = (a: string, b: string) =>
  clean(a).toLowerCase() === clean(b).toLowerCase();
const txKey = (no: string, paise: number, date: string, ref: string) =>
  [no, paise, date, ref.toLowerCase().replace(/\s+/g, "")].join("\u0001");

// In a transactions file a "Remarks" column belongs to each row, so it maps to Notes (changeable in the mapping screen).
const SYNONYMS: Record<string, string[]> = {
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
  reference_no: [
    "referenceno",
    "refno",
    "reference",
    "ref",
    "billno",
    "billnumber",
    "billnos",
    "invoiceno",
    "invoicenumber",
  ],
  entry_date: [
    "date",
    "entrydate",
    "transactiondate",
    "txndate",
    "paymentdate",
    "valuedate",
  ],
  amount_paise: [
    "amount",
    "amountrs",
    "amountinrs",
    "amt",
    "netamount",
    "paymentamount",
    "amountpaid",
  ],
  utr: ["utr", "utrno", "utrnumber", "utrnoifany"],
  notes: [
    "notes",
    "note",
    "remarks",
    "remark",
    "narration",
    "particulars",
    "description",
  ],
};
const SYN = new Map<string, string>();
for (const [k, list] of Object.entries(SYNONYMS))
  for (const s of list) SYN.set(s, k);

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
function parseDateLoose(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  const direct = parseDate(t);
  if (direct) return direct;
  let m = t.match(/^(\d{1,2})[\s\-/.]([A-Za-z]{3,9})[\s\-/.,]+(\d{2}|\d{4})$/); // 5-Nov-26, 05 Nov 2026
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()])
    return parseDate(
      `${m[1]}/${MONTHS[m[2].slice(0, 3).toLowerCase()]}/${m[3]}`,
    );
  if (/^\d{5}$/.test(t) && +t > 20000 && +t < 80000)
    // Excel serial number
    return new Date(Date.UTC(1899, 11, 30) + +t * 86_400_000)
      .toISOString()
      .slice(0, 10);
  m = t.match(/^(\S+)[\sT]\d{1,2}:\d{2}/); // date followed by a time
  return m ? parseDate(m[1]) : null;
}

function parseAmountPaise(
  s: string,
): { ok: true; paise: number } | { ok: false; why: string } {
  const t = s.replace(/[,\s₹]/g, "").replace(/^rs\.?/i, "");
  if (!t) return { ok: false, why: "Missing amount" };
  if (!/^\d+(\.\d+)?$/.test(t))
    return { ok: false, why: "Amount is not a valid number" };
  const x = Number(t) * 100;
  const paise = Math.round(x);
  if (Math.abs(x - paise) > 0.001)
    return { ok: false, why: "Amount has more than 2 decimal places" };
  if (!Number.isSafeInteger(paise))
    return { ok: false, why: "Amount is too large" };
  return { ok: true, paise };
}

/** Raw cell value, not the displayed text: numbers keep every decimal, dates arrive as ISO, long numbers are flagged. */
function readCell(c: ExcelJS.Cell): { text: string; risky: boolean } {
  let v: unknown = c.value;
  if (v && typeof v === "object" && !(v instanceof Date) && "result" in v)
    v = (v as { result?: unknown }).result; // formula
  if (v instanceof Date)
    return { text: v.toISOString().slice(0, 10), risky: false };
  if (typeof v === "number")
    return { text: String(v), risky: Math.abs(v) >= 1e15 }; // 15+ digits: Excel has already lost digits
  const text = (c.text ?? "").trim();
  return { text, risky: /^\d(\.\d+)?e\+\d+$/i.test(text) };
}

// ---------- session ----------
interface Row {
  n: number;
  cells: string[];
  risky: number[];
}
let session: { source: string; headers: string[]; rows: Row[] } | null = null;
let plan: TxImportPlan | null = null;
export const getPlan = () => plan;
export const clearSession = () => {
  session = null;
  plan = null;
};

function autoMap(db: DB, headers: string[]): (string | null)[] {
  const custom = db
    .prepare("SELECT key, label FROM custom_fields WHERE archived = 0")
    .all() as { key: string; label: string }[];
  const customKeys = new Set(custom.map((c) => c.key));
  const byLabel = new Map(custom.map((c) => [norm(c.label), c.key]));
  const saved = new Map(
    (
      db.prepare("SELECT header, field_key FROM import_mappings").all() as {
        header: string;
        field_key: string;
      }[]
    ).map((r) => [r.header, r.field_key]),
  );
  const used = new Set<string>();
  return headers.map((h) => {
    const n = norm(h);
    const key = saved.get(n) ?? SYN.get(n) ?? byLabel.get(n);
    if (!key || used.has(key) || !(KEYS.includes(key) || customKeys.has(key)))
      return null;
    used.add(key);
    return key;
  });
}

/** Finds the header row: the row (within the first 40) matching the most DIFFERENT known column names. Titles, sub-titles and merged banners match nothing. */
function findHeaderIndex(db: DB, grid: Row[]): number {
  const known = new Map<string, string>();
  for (const c of db
    .prepare("SELECT key, label FROM custom_fields WHERE archived = 0")
    .all() as { key: string; label: string }[])
    known.set(norm(c.label), c.key);
  for (const [n, k] of SYN) known.set(n, k);
  for (const r of db
    .prepare("SELECT header, field_key FROM import_mappings")
    .all() as { header: string; field_key: string }[])
    known.set(r.header, r.field_key);

  let best = -1,
    bestScore = 0;
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const keys = new Set<string>(); // distinct fields, so a title merged across many cells cannot score high
    for (const c of grid[i].cells) {
      const k = known.get(norm(c));
      if (k) keys.add(k);
    }
    if (keys.size > bestScore) {
      best = i;
      bestScore = keys.size;
    } // earliest row wins a tie
  }
  if (bestScore >= 2) return best;
  // nothing recognisable: first row with at least 3 different filled cells (skips a title merged across the sheet)
  const i = grid.findIndex((r) => new Set(r.cells.filter(Boolean)).size >= 3);
  return i >= 0 ? i : 0;
}

export async function loadFile(
  db: DB,
  filePath: string,
): Promise<TxImportFileInfo> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("No sheet found in file");
  const width = ws.columnCount;
  const grid: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const cells: string[] = [],
      risky: number[] = [];
    for (let c = 1; c <= width; c++) {
      const r = readCell(row.getCell(c));
      cells.push(r.text);
      if (r.risky) risky.push(c - 1);
    }
    if (cells.some((x) => x !== "")) grid.push({ n, cells, risky }); // styled but empty rows are ignored
  });
  if (grid.length < 2)
    throw new Error("Need a header row and at least one data row");
  const hi = findHeaderIndex(db, grid);
  const headers = grid[hi].cells.map((h, i) => h || `Column ${i + 1}`);
  const rows = grid.slice(hi + 1).filter((r) => r.cells.some((x) => x !== ""));
  if (!rows.length) throw new Error("No data rows found below the header row");
  const source = filePath.split(/[\\/]/).pop()!;
  session = { source, headers, rows };
  plan = null;
  return {
    source,
    headers,
    rowCount: rows.length,
    headerRow: grid[hi].n,
    mapping: autoMap(db, headers),
  };
}

// ---------- analysis ----------
interface DbAcc {
  id: string;
  payee: string;
  bank: string;
  branch: string;
  account_no: string;
  ifsc: string;
  in_master: number;
}

const buildFields = (g: PlannedAccount, cur?: DbAcc): FieldConflict[] => {
  const out: FieldConflict[] = [];
  for (const [f, label] of COMPARE) {
    const cands: FieldCandidate[] = [...g.seen[f].entries()].map(
      ([value, rows]) => ({
        value,
        source: "file" as const,
        rows: rows.slice(0, 20),
        count: rows.length,
      }),
    );
    const dbVal = cur ? cur[f] : "";
    const fileConflict = cands.length > 1;
    const masterDiff = !!(cur && cands.length && !same(cands[0].value, dbVal));
    if (!fileConflict && !masterDiff) continue;
    if (dbVal && !cands.some((c) => same(c.value, dbVal)))
      cands.unshift({ value: dbVal, source: "master", rows: [], count: 0 });
    out.push({
      field: f,
      label,
      candidates: cands,
      defaultValue: g.values[f],
      current: dbVal,
    });
  }
  return out;
};

export function analyze(db: DB, mapping: (string | null)[]): TxImportAnalysis {
  const s = session;
  if (!s) throw new Error("Nothing loaded. Start the import again.");
  const customScope = new Map(
    (
      db
        .prepare("SELECT key, scope FROM custom_fields WHERE archived = 0")
        .all() as { key: string; scope: string }[]
    ).map((r) => [r.key, r.scope]),
  );
  if (
    !Array.isArray(mapping) ||
    mapping.length !== s.headers.length ||
    mapping.some((k) => k !== null && !KEYS.includes(k) && !customScope.has(k))
  )
    throw new Error("Invalid mapping");
  const picked = mapping.filter((k): k is string => !!k);
  if (new Set(picked).size !== picked.length)
    throw new Error("Two columns map to the same field");
  for (const [k, label] of REQUIRED)
    if (!picked.includes(k)) throw new Error(`Map the ${label} column`);
  const dateMode: "column" | "today" = picked.includes("entry_date")
    ? "column"
    : "today";
  const accCol = mapping.indexOf("account_no");
  const today = todayIso();

  // every account already in the database, keyed by account number (a master account wins over a one-off, the oldest wins among equals)
  const dbAcc = new Map<string, DbAcc>();
  for (const a of db
    .prepare(
      "SELECT id, payee, bank, branch, account_no, ifsc, in_master FROM accounts WHERE account_no <> '' ORDER BY in_master ASC, created_at DESC",
    )
    .all() as DbAcc[])
    dbAcc.set(a.account_no, a);

  // pass 1: read, validate and group rows by account number
  interface Parsed {
    n: number;
    v: Record<string, string>;
    no: string;
    paise: number;
    date: string;
    ref: string;
    utr: string;
    notes: string;
    extra: Record<string, string>;
  }
  const rejected: Rejected[] = [];
  const groups = new Map<string, PlannedAccount>();
  const parsed: Parsed[] = [];

  for (const { n, cells, risky } of s.rows) {
    const v: Record<string, string> = {};
    mapping.forEach((k, i) => {
      if (k) v[k] = cells[i] ?? "";
    });
    const bad = (reason: string) => {
      rejected.push({ row: n, reason, values: v });
    };

    const no = (v.account_no ?? "")
      .replace(/\s/g, "")
      .replace(/^'/, "")
      .slice(0, 60);
    if (!no) {
      bad("Missing account number");
      continue;
    }
    if (risky.includes(accCol)) {
      bad(
        "Account number damaged by Excel (long number). Format the column as Text, re-enter it and save again",
      );
      continue;
    }
    const amt = parseAmountPaise(v.amount_paise ?? "");
    if (!amt.ok) {
      bad(amt.why);
      continue;
    }
    let date = today;
    if (dateMode === "column") {
      const d = parseDateLoose(v.entry_date ?? "");
      if (!d) {
        bad("Missing or unreadable date");
        continue;
      }
      date = d;
    }
    const ifsc = cleanIfsc(v.ifsc ?? "");
    if (ifsc && !isValidIfsc(ifsc)) {
      bad("Invalid IFSC");
      continue;
    }

    let g = groups.get(no);
    if (!g) {
      const cur = dbAcc.get(no);
      g = {
        account_no: no,
        values: { payee: "", bank: "", branch: "", ifsc: "", remarks: "" },
        extra: {},
        existingId: cur?.id ?? null,
        existingInMaster: cur ? cur.in_master === 1 : false,
        rows: [],
        conflicts: [],
        seen: {
          payee: new Map(),
          bank: new Map(),
          branch: new Map(),
          ifsc: new Map(),
        },
      };
      groups.set(no, g);
    }
    g.rows.push(n);
    const fv = {
      payee: clean(v.payee),
      bank: clean(v.bank),
      branch: clean(v.branch),
      ifsc,
    };
    for (const [f, label] of COMPARE) {
      if (!fv[f]) continue;
      const key = [...g.seen[f].keys()].find((x) => same(x, fv[f])) ?? fv[f];
      g.seen[f].set(key, [...(g.seen[f].get(key) ?? []), n]);
      if (!g.values[f])
        g.values[f] = fv[f]; // first non-empty value wins
      else if (!same(g.values[f], fv[f])) {
        const msg = `${label}: ${g.values[f]} / ${fv[f]}`;
        if (!g.conflicts.includes(msg)) g.conflicts.push(msg);
      }
    }
    if (!g.values.remarks) g.values.remarks = clean(v.remarks, 500);
    const extra: Record<string, string> = {};
    for (const k of picked) {
      const val = clean(v[k], 500);
      if (!customScope.has(k) || !val) continue;
      if (customScope.get(k) === "account") {
        if (!g.extra[k]) g.extra[k] = val;
      } else extra[k] = val;
    }
    parsed.push({
      n,
      v,
      no,
      paise: amt.paise,
      date,
      ref: clean(v.reference_no),
      utr: clean(v.utr),
      notes: clean(v.notes, 500),
      extra,
    });
  }

  // a NEW account needs a beneficiary name (a known account can borrow it from the database)
  const dropped = new Set<string>();
  for (const g of groups.values())
    if (!g.existingId && !g.values.payee) dropped.add(g.account_no);
  for (const p of parsed)
    if (dropped.has(p.no))
      rejected.push({
        row: p.n,
        reason: "Missing beneficiary for a new account",
        values: p.v,
      });
  for (const no of dropped) groups.delete(no);
  const rows = parsed.filter((p) => !dropped.has(p.no));

  // transactions already in the database inside the file's date range: matching is by COUNT, so genuine twins still import
  const counts = new Map<string, number>();
  if (rows.length) {
    let lo = rows[0].date,
      hi = rows[0].date;
    for (const p of rows) {
      if (p.date < lo) lo = p.date;
      if (p.date > hi) hi = p.date;
    }
    const found = db
      .prepare(
        `SELECT a.account_no AS no, t.amount_paise AS amt, t.entry_date AS d, t.reference_no AS ref, COUNT(*) AS c
           FROM transactions t JOIN accounts a ON a.id = t.account_id
          WHERE t.deleted_at IS NULL AND t.entry_date BETWEEN ? AND ?
          GROUP BY a.account_no, t.amount_paise, t.entry_date, t.reference_no`,
      )
      .all(lo, hi) as {
      no: string;
      amt: number;
      d: string;
      ref: string;
      c: number;
    }[];
    for (const r of found) {
      const k = txKey(r.no, r.amt, r.d, r.ref);
      counts.set(k, (counts.get(k) ?? 0) + r.c);
    }
  }

  // pass 2: classify transactions, raise exceptions
  const exceptions: TxException[] = [];
  const exc = (
    e: Omit<TxException, "rows" | "rowCount"> & { allRows: number[] },
  ) => {
    const { allRows, ...rest } = e;
    exceptions.push({
      ...rest,
      rows: allRows.slice(0, 20),
      rowCount: allRows.length,
    });
  };

  for (const g of groups.values()) {
    const cur = g.existingId ? dbAcc.get(g.account_no) : undefined;
    const fields = buildFields(g, cur);
    if (g.conflicts.length)
      exc({
        id: `conf:${g.account_no}`,
        kind: "file_conflict",
        allRows: g.rows,
        account_no: g.account_no,
        payee: g.values.payee,
        detail: g.conflicts.join("; ") + " (first value is used)",
        fields: fields.filter(
          (f) => f.candidates.filter((c) => c.source === "file").length > 1,
        ),
      });
    if (cur) {
      const diffs = COMPARE.filter(
        ([f]) => g.values[f] && !same(g.values[f], cur[f]),
      ).map(
        ([f, label]) => `${label}: ${cur[f] || "(empty)"} → ${g.values[f]}`,
      );
      if (diffs.length)
        exc({
          id: `diff:${g.account_no}`,
          kind: "master_diff",
          allRows: g.rows,
          account_no: g.account_no,
          payee: cur.payee,
          detail: diffs.join("; "),
          fields: fields.filter(
            (f) =>
              f.candidates.some((c) => c.source === "master") ||
              !same(f.defaultValue, cur[f.field]),
          ),
        });
    }
  }

  const seen = new Map<string, number>();
  const txs: PlannedTx[] = [];
  let fresh = 0,
    exists = 0;
  for (const p of rows) {
    const key = txKey(p.no, p.paise, p.date, p.ref);
    const i = (seen.get(key) ?? 0) + 1;
    seen.set(key, i);
    const status: "fresh" | "exists" =
      i <= (counts.get(key) ?? 0) ? "exists" : "fresh";
    const flags: string[] = [];
    if (status === "fresh") {
      const payee =
        groups.get(p.no)?.values.payee || dbAcc.get(p.no)?.payee || "";
      if (p.paise === 0) {
        flags.push(`zero:${p.n}`);
        exc({
          id: `zero:${p.n}`,
          kind: "zero_amount",
          allRows: [p.n],
          account_no: p.no,
          payee,
          detail: "Amount is zero",
        });
      } else if (p.paise >= HIGH_VALUE_PAISE) {
        flags.push(`high:${p.n}`);
        exc({
          id: `high:${p.n}`,
          kind: "high_value",
          allRows: [p.n],
          account_no: p.no,
          payee,
          detail: `High value: ₹${formatPaise(p.paise)}`,
        });
      }
      fresh++;
    } else exists++;
    txs.push({
      row: p.n,
      account_no: p.no,
      amount_paise: p.paise,
      entry_date: p.date,
      reference_no: p.ref,
      utr: p.utr,
      notes: p.notes,
      extra: p.extra,
      status,
      flags,
    });
  }
  const twinGroups = [...seen.values()].filter((c) => c >= 2).length;

  let nNew = 0,
    nExisting = 0,
    nOneOff = 0;
  for (const g of groups.values()) {
    if (!g.existingId) nNew++;
    else {
      nExisting++;
      if (!g.existingInMaster) nOneOff++;
    }
  }

  plan = {
    source: s.source,
    headers: s.headers,
    mapping,
    accounts: groups,
    txs,
    exceptions,
    rejected,
  };
  return {
    total: s.rows.length,
    dateMode,
    accounts: { new: nNew, existing: nExisting, oneOffExisting: nOneOff },
    transactions: { fresh, exists, twinGroups },
    rejectedCount: rejected.length,
    rejected: rejected.slice(0, 200),
    exceptions,
  };
}

// ---------- commit ----------
export interface TxImportOptions {
  newAccounts: "master" | "oneoff"; // where accounts that do not exist yet go (also promotes matched one-off accounts when 'master')
  masterDiff: "keep" | "update"; // bulk rule for existing accounts whose file details differ from master
  existingTx: "skip" | "import"; // rows the database already has
  confirmKinds?: ("zero_amount" | "high_value")[]; // kinds the user ticked for all rows
  decisions?: Record<string, "import" | "skip" | "update" | "keep">; // per-exception overrides by exception id
  fieldChoices?: Record<string, Partial<Record<AccField, string>>>; // account_no -> field -> chosen value
}
export interface TxImportResult {
  batchId: number;
  accountsAdded: number;
  accountsUpdated: number;
  accountsPromoted: number;
  txAdded: number;
  txSkippedExisting: number;
  txSkippedUnconfirmed: number;
}
interface AccRow {
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
interface AccountChange {
  id: string;
  at: string;
  prev: Omit<AccRow, "id">;
}

export function commit(db: DB, opts: TxImportOptions): TxImportResult {
  if (!plan || !session)
    throw new Error("Nothing to import. Start the import again.");
  if (
    !["master", "oneoff"].includes(opts.newAccounts) ||
    !["keep", "update"].includes(opts.masterDiff) ||
    !["skip", "import"].includes(opts.existingTx)
  )
    throw new Error("Invalid import options");
  analyze(db, plan.mapping); // re-check against the database as it is right now
  const p = plan!;
  const now = new Date().toISOString();
  const confirmed = new Set(opts.confirmKinds ?? []);
  const dec = opts.decisions ?? {};
  const choices = new Map<string, Partial<Record<AccField, string>>>();
  for (const [no, c] of Object.entries(opts.fieldChoices ?? {})) {
    if (!p.accounts.has(no)) continue;
    const o: Partial<Record<AccField, string>> = {};
    for (const [f] of COMPARE) {
      if (typeof c?.[f] !== "string") continue;
      const v = f === "ifsc" ? cleanIfsc(c[f]!) : clean(c[f]);
      if (f === "ifsc" && v && !isValidIfsc(v))
        throw new Error("Invalid IFSC choice");
      if (v) o[f] = v;
    }
    if (Object.keys(o).length) choices.set(no, o);
  }
  const diffIds = new Set(
    p.exceptions.filter((e) => e.kind === "master_diff").map((e) => e.id),
  );

  const wanted = (t: PlannedTx): "yes" | "exists" | "unconfirmed" => {
    if (t.status === "exists" && opts.existingTx === "skip") return "exists";
    for (const id of t.flags) {
      const kind = id.startsWith("zero:") ? "zero_amount" : "high_value";
      if (dec[id] === "skip" || (dec[id] !== "import" && !confirmed.has(kind)))
        return "unconfirmed";
    }
    return "yes";
  };

  const insBatch = db.prepare(
    "INSERT INTO import_batches (created_at, file_name) VALUES (?, ?)",
  );
  const insAcc = db.prepare(
    `INSERT INTO accounts (id, payee, bank, branch, account_no, ifsc, remarks, in_master, extra, created_at, updated_at, batch_id)
     VALUES (@id, @payee, @bank, @branch, @account_no, @ifsc, @remarks, @in_master, @extra, @now, @now, @batch)`,
  );
  const getAcc = db.prepare(
    "SELECT id, payee, bank, branch, ifsc, remarks, in_master, extra, updated_at FROM accounts WHERE id = ?",
  );
  const updAcc = db.prepare(
    "UPDATE accounts SET payee=@payee, bank=@bank, branch=@branch, ifsc=@ifsc, remarks=@remarks, in_master=@in_master, extra=@extra, updated_at=@now WHERE id=@id",
  );
  const insTx = db.prepare(
    `INSERT INTO transactions (uid, account_id, amount_paise, reference_no, utr, notes, entry_date, extra, created_at, updated_at, batch_id)
     VALUES (@uid, @account_id, @amount, @ref, @utr, @notes, @date, @extra, @now, @now, @batch)`,
  );
  const saveMap = db.prepare(
    "INSERT OR REPLACE INTO import_mappings(header, field_key) VALUES (?, ?)",
  );

  let result!: TxImportResult;
  db.transaction(() => {
    const batch = Number(insBatch.run(now, p.source).lastInsertRowid);
    const ids = new Map<string, string>(); // account number -> account id
    const touched = new Set<string>();
    const changes: AccountChange[] = [];
    let added = 0,
      updated = 0,
      promoted = 0,
      txAdded = 0,
      skipEx = 0,
      skipUn = 0;

    for (const t of p.txs) {
      const w = wanted(t);
      if (w === "exists") {
        skipEx++;
        continue;
      }
      if (w === "unconfirmed") {
        skipUn++;
        continue;
      }

      let id = ids.get(t.account_no);
      if (!id) {
        const g = p.accounts.get(t.account_no)!;
        if (!g.existingId) {
          id = randomUUID();
          insAcc.run({
            id,
            ...g.values,
            ...(choices.get(g.account_no) ?? {}),
            account_no: g.account_no,
            in_master: opts.newAccounts === "master" ? 1 : 0,
            extra: JSON.stringify(g.extra),
            now,
            batch,
          });
          added++;
        } else {
          id = g.existingId;
          const cur = getAcc.get(id) as AccRow;
          const ruleUpdate =
            diffIds.has(`diff:${g.account_no}`) &&
            (dec[`diff:${g.account_no}`] ?? opts.masterDiff) === "update";
          const pick = choices.get(g.account_no);
          const doUpdate = ruleUpdate || !!pick;
          const promote = cur.in_master === 0 && opts.newAccounts === "master";
          if (doUpdate || promote) {
            const next = {
              payee: cur.payee,
              bank: cur.bank,
              branch: cur.branch,
              ifsc: cur.ifsc,
              remarks: cur.remarks,
              in_master: cur.in_master,
              extra: cur.extra,
            };
            if (doUpdate) {
              if (ruleUpdate) {
                for (const f of [
                  "payee",
                  "bank",
                  "branch",
                  "ifsc",
                  "remarks",
                ] as const)
                  if (g.values[f]) next[f] = g.values[f];
                next.extra = JSON.stringify({
                  ...JSON.parse(cur.extra || "{}"),
                  ...g.extra,
                });
              }
              if (pick) Object.assign(next, pick); // explicit choices win over the bulk rule
            }
            if (promote) next.in_master = 1;
            const { id: _id, ...prev } = cur;
            changes.push({ id, at: now, prev });
            updAcc.run({ ...next, id, now });
            if (doUpdate) updated++;
            if (promote) promoted++;
          }
        }
        ids.set(t.account_no, id);
      }
      insTx.run({
        uid: randomUUID(),
        account_id: id,
        amount: t.amount_paise,
        ref: t.reference_no.slice(0, 100),
        utr: t.utr.slice(0, 100),
        notes: t.notes.slice(0, 500),
        date: t.entry_date,
        extra: JSON.stringify(t.extra),
        now,
        batch,
      });
      touched.add(id);
      txAdded++;
    }

    for (const id of touched) refreshAccountStats(db, id);
    p.mapping.forEach((k, i) => {
      if (k) saveMap.run(norm(p.headers[i]), k);
    }); // the next import auto-maps the same headers
    db.prepare(
      "UPDATE import_batches SET acc_count = ?, tx_count = ?, account_changes = ? WHERE id = ?",
    ).run(added, txAdded, JSON.stringify(changes), batch);
    audit(db, "import_batches", String(batch), "create", {
      file: [null, p.source],
      transactions: [null, txAdded],
      accounts_added: [null, added],
      accounts_updated: [null, updated],
    });
    result = {
      batchId: batch,
      accountsAdded: added,
      accountsUpdated: updated,
      accountsPromoted: promoted,
      txAdded,
      txSkippedExisting: skipEx,
      txSkippedUnconfirmed: skipUn,
    };
  })();
  clearSession(); // a second click on Import cannot commit the same file twice
  return result;
}

// ---------- undo ----------
export interface UndoInfo {
  id: number;
  created_at: string;
  file_name: string;
  transactions: number;
  edited: number; // imported transactions changed since the import (e.g. UTR added); undo deletes them too
  newAccounts: number;
  inReports: number; // imported transactions already used in a saved report
  canUndo: boolean;
}

/** The most recent import that has not been undone, or null. */
export function undoInfo(db: DB): UndoInfo | null {
  const b = db
    .prepare(
      "SELECT id, created_at, file_name, acc_count FROM import_batches WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get() as
    | { id: number; created_at: string; file_name: string; acc_count: number }
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
  return {
    id: b.id,
    created_at: b.created_at,
    file_name: b.file_name,
    transactions: t.n,
    edited: t.edited,
    newAccounts: b.acc_count,
    inReports: r.n,
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
  };

  db.transaction(() => {
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
      },
      "Import undone",
    );
  })();
  return out;
}
