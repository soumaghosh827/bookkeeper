// Transactions Excel import, step 2: load the file and ANALYSE it. Nothing here writes to the database.
// The commit and undo steps (next files) read the result through getPlan().
import { randomUUID } from "crypto";
import { audit } from "./audit";
import { refreshAccountStats } from "./accounts";
import type { DB } from "../db";
import type { Workbook } from "exceljs";
import { formatPaise, parseDate, todayIso } from "@shared/format";
import { HIGH_VALUE_PAISE } from "@shared/rules";
import {
  COMPARE,
  clean,
  same,
  buildFields,
  sanitizeChoices,
  applyAccountUpdate,
  type AccField,
  type FieldConflict,
} from "./accountConflicts";
export type {
  AccField,
  FieldCandidate,
  FieldConflict,
} from "./accountConflicts";
import type {
  TxImportFileInfo,
  TxImportAnalysis,
  TxImportOptions,
  TxImportResult,
  TxImportRejected as Rejected,
  TxImportException as TxException,
  SheetChoice,
} from "@shared/types";
import {
  norm,
  DAMAGED_MSG,
  ACCOUNT_SYNONYMS,
  autoMapHeaders,
  findHeaderRow,
  saveHeaderMappings,
  accountWriter,
  openWorkbook,
  readWorksheet,
  listSheets,
  loadAccountIndex,
  readAccountFields,
  newGroup,
  addRowToGroup,
  twinChecker,
  type AccountGroup,
  type SheetRow,
} from "./importCore";

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

// ---------- plan (main process only; the types the UI sees live in shared/types.ts) ----------
export interface PlannedAccount extends AccountGroup {
  existingId: string | null;
  existingInMaster: boolean;
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
const txKey = (no: string, paise: number, date: string, ref: string) =>
  [no, paise, date, ref.toLowerCase().replace(/\s+/g, "")].join("\u0001");

// In a transactions file a "Remarks" column belongs to each row, so it maps to Notes (changeable in the mapping screen).
const SYNONYMS: Record<string, string[]> = {
  ...ACCOUNT_SYNONYMS,
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
    "amountinr",
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

// ---------- session ----------
type Row = SheetRow;
let session: {
  source: string;
  headers: string[];
  rows: Row[];
  wb: Workbook;
  sheets: SheetChoice[];
  sheet: string;
} | null = null;
let plan: TxImportPlan | null = null;
export const getPlan = () => plan;
export const clearSession = () => {
  session = null;
  plan = null;
};

function autoMap(db: DB, headers: string[]): (string | null)[] {
  return autoMapHeaders(db, headers, SYN, KEYS);
}

function findHeaderIndex(db: DB, grid: Row[]): number {
  return findHeaderRow(
    db,
    grid.map((r) => r.cells),
    SYN,
  );
}

/** Loads one sheet of the open workbook into the session and returns what the mapping screen needs. */
function loadSheet(
  db: DB,
  wb: Workbook,
  source: string,
  sheets: SheetChoice[],
  name: string,
): TxImportFileInfo {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error("Sheet not found");
  const grid = readWorksheet(ws);
  if (grid.length < 2)
    throw new Error("This sheet needs a header row and at least one data row");
  const hi = findHeaderIndex(db, grid);
  const headers = grid[hi].cells.map((h, i) => h || `Column ${i + 1}`);
  const rows = grid.slice(hi + 1).filter((r) => r.cells.some((x) => x !== ""));
  if (!rows.length)
    throw new Error("No data rows found below the header row of this sheet");
  session = { source, headers, rows, wb, sheets, sheet: name };
  plan = null;
  return {
    source,
    sheet: name,
    sheets,
    headers,
    rowCount: rows.length,
    headerRow: grid[hi].n,
    mapping: autoMap(db, headers),
  };
}

export async function loadFile(
  db: DB,
  filePath: string,
): Promise<TxImportFileInfo> {
  const wb = await openWorkbook(filePath);
  const sheets = listSheets(db, wb, SYN);
  const first = sheets.find((s) => s.recommended) ?? sheets[0];
  const source = filePath.split(/[\\/]/).pop()!;
  return loadSheet(db, wb, source, sheets, first.name);
}

/** The person picked another sheet: reload headers, rows and auto-mapping from it. */
export function selectSheet(db: DB, name: string): TxImportFileInfo {
  if (!session) throw new Error("Nothing loaded. Start the import again.");
  return loadSheet(db, session.wb, session.source, session.sheets, name);
}

// ---------- analysis ----------

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

  // every stored account, loaded once (a master account wins over a one-off, the oldest wins among equals)
  const index = loadAccountIndex(db);

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

  for (const { n, cells, raws, risky } of s.rows) {
    const v: Record<string, string> = {};
    mapping.forEach((k, i) => {
      // amount and date read the raw value; every other column reads the displayed text
      if (k)
        v[k] =
          (k === "amount_paise" || k === "entry_date" ? raws[i] : cells[i]) ??
          "";
    });
    const bad = (reason: string) => {
      rejected.push({ row: n, reason, values: v });
    };

    const acc = readAccountFields(v, risky.includes(accCol));
    if (acc.noAccount) {
      bad("Missing account number");
      continue;
    }
    if (acc.damaged) {
      bad(DAMAGED_MSG);
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
    if (acc.badIfsc) {
      bad("Invalid IFSC");
      continue;
    }

    const no = acc.fields.account_no;
    let g = groups.get(no);
    if (!g) {
      const cur = index.byNo.get(no);
      g = {
        ...newGroup(no),
        existingId: cur?.id ?? null,
        existingInMaster: cur ? cur.in_master === 1 : false,
      };
      groups.set(no, g);
    }
    addRowToGroup(g, acc.fields, n);

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

  const twinOf = twinChecker(index);

  for (const g of groups.values()) {
    const like = g.existingId
      ? null
      : twinOf(g.values.payee, g.values.ifsc, g.account_no);
    if (like) {
      const { stored: twin, earlierNo: earlier } = like;
      const where = twin
        ? [twin.bank, twin.branch].filter(Boolean).join(" · ")
        : "";
      exc({
        id: `like:${g.account_no}`,
        kind: "look_alike",
        allRows: g.rows,
        account_no: g.account_no,
        payee: g.values.payee,
        detail: twin
          ? `Same name and IFSC as saved A/c ${twin.account_no}${where ? ` (${where})` : ""}`
          : `Same name and IFSC as A/c ${earlier} earlier in this file`,
      });
    }
    const cur = g.existingId ? index.byNo.get(g.account_no) : undefined;
    const fields = buildFields(g.seen, g.values, cur);
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
        groups.get(p.no)?.values.payee || index.byNo.get(p.no)?.payee || "";
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
  const choices = sanitizeChoices(opts.fieldChoices, p.accounts);
  const diffIds = new Set(
    p.exceptions.filter((e) => e.kind === "master_diff").map((e) => e.id),
  );
  const skipAccounts = new Set(
    p.exceptions
      .filter((e) => e.kind === "look_alike" && dec[e.id] === "skip")
      .map((e) => e.account_no),
  );

  const wanted = (
    t: PlannedTx,
  ): "yes" | "exists" | "unconfirmed" | "lookalike" => {
    if (skipAccounts.has(t.account_no)) return "lookalike";
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
  const getAcc = db.prepare(
    "SELECT id, payee, bank, branch, ifsc, remarks, in_master, extra, updated_at FROM accounts WHERE id = ?",
  );
  const writer = accountWriter(db);
  const insTx = db.prepare(
    `INSERT INTO transactions (uid, account_id, amount_paise, reference_no, utr, notes, entry_date, extra, created_at, updated_at, batch_id)
     VALUES (@uid, @account_id, @amount, @ref, @utr, @notes, @date, @extra, @now, @now, @batch)`,
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
      skipUn = 0,
      skipLike = 0;

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
      if (w === "lookalike") {
        skipLike++;
        continue;
      }

      let id = ids.get(t.account_no);
      if (!id) {
        const g = p.accounts.get(t.account_no)!;
        if (!g.existingId) {
          id = randomUUID();
          writer.insert({
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
          const fieldsNext =
            ruleUpdate || pick
              ? applyAccountUpdate(cur, g, ruleUpdate, pick)
              : null;
          const promote = cur.in_master === 0 && opts.newAccounts === "master";
          if (fieldsNext || promote) {
            const base = fieldsNext ?? {
              payee: cur.payee,
              bank: cur.bank,
              branch: cur.branch,
              ifsc: cur.ifsc,
              remarks: cur.remarks,
              extra: cur.extra,
            };
            const next = { ...base, in_master: promote ? 1 : cur.in_master };
            const { id: _id, ...prev } = cur;
            changes.push({ id, at: now, prev });
            writer.update({ ...next, id, now });
            if (fieldsNext) updated++;
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
    saveHeaderMappings(db, p.headers, p.mapping); // the next import auto-maps the same headers
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
      txSkippedLookAlike: skipLike,
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
