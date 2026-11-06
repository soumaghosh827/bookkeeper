import ExcelJS from "exceljs";
import { randomUUID } from "crypto";
import type { DB } from "../db";
import {
  ACCOUNT_KEYS,
  customKey,
  isCustomKey,
  type AccountKey,
  type ColumnMapping,
  type CustomColumn,
  type ImportFileInfo,
  type ImportProblem,
} from "@shared/types";
import { cleanIfsc, isValidIfsc } from "@shared/format";
import {
  COMPARE,
  same,
  newSeen,
  addSeen,
  buildFields,
  type AccField,
  type FieldConflict,
  type SeenMap,
  sanitizeChoices,
  applyAccountUpdate,
} from "./accountConflicts";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, ""); // "A/C No." -> "acno"

// Extend this list whenever you meet a new header variation.
const SYNONYMS: Record<AccountKey, string[]> = {
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
  ifsc: ["ifsc", "ifsccode", "ifscno", "ifscnumber"],
  remarks: [
    "remarks",
    "remark",
    "note",
    "notes",
    "narration",
    "particulars",
    "description",
  ],
};
const SYN = new Map<string, AccountKey>();
for (const k of ACCOUNT_KEYS) for (const s of SYNONYMS[k]) SYN.set(s, k);
const POSITIONAL: AccountKey[] = [
  "payee",
  "bank",
  "branch",
  "account_no",
  "ifsc",
  "remarks",
]; // headerless paste

// The parsed input is held in main-process memory between steps (never sent whole to the UI).
let session: {
  source: string;
  headers: string[];
  rows: { n: number; cells: string[] }[];
} | null = null;

/** Minimal TSV parser (what Excel puts on the clipboard), including "quoted\tcells" and doubled quotes. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    q = false;
  const t = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

function autoMap(
  db: DB,
  headers: string[],
  headerless: boolean,
): { mapping: ColumnMapping; customFields: CustomColumn[] } {
  const customFields = (
    db
      .prepare(
        "SELECT key, label, scope, position, archived FROM custom_fields WHERE scope = 'account' AND archived = 0 ORDER BY position, key",
      )
      .all() as any[]
  ).map((r) => ({ ...r, archived: !!r.archived })) as CustomColumn[];
  if (headerless)
    return {
      mapping: headers.map((_, i) => POSITIONAL[i] ?? null),
      customFields,
    };
  const byLabel = new Map(customFields.map((c) => [norm(c.label), c.key]));
  const saved = new Map(
    (
      db.prepare("SELECT header, field_key FROM import_mappings").all() as any[]
    ).map((r) => [r.header as string, r.field_key as string]),
  );
  const used = new Set<string>();
  const mapping = headers.map((h) => {
    const n = norm(h);
    const key = saved.get(n) ?? SYN.get(n) ?? byLabel.get(n) ?? null;
    if (
      key &&
      !used.has(key) &&
      ((ACCOUNT_KEYS as readonly string[]).includes(key) || isCustomKey(key))
    ) {
      used.add(key);
      return key;
    }
    return null;
  });
  return { mapping, customFields };
}

function setSession(
  db: DB,
  source: string,
  grid: string[][],
  hasHeader: boolean,
): ImportFileInfo {
  const width = Math.max(0, ...grid.map((r) => r.length));
  const pad = (r: string[]) =>
    Array.from({ length: width }, (_, i) => r[i] ?? "");
  const headers = hasHeader
    ? pad(grid[0]).map((h, i) => h || `Column ${i + 1}`)
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const body = hasHeader ? grid.slice(1) : grid;
  const rows = body
    .map((cells, i) => ({ n: i + (hasHeader ? 2 : 1), cells: pad(cells) }))
    .filter((r) => r.cells.some((x) => x !== ""));
  if (!rows.length)
    throw new Error(
      hasHeader
        ? "Need a header row and at least one data row"
        : "Nothing to import",
    );
  session = { source, headers, rows };
  return {
    source,
    headers,
    rowCount: rows.length,
    ...autoMap(db, headers, !hasHeader),
  };
}

export async function loadFile(
  db: DB,
  filePath: string,
): Promise<ImportFileInfo> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("No sheet found in file");
  const width = ws.columnCount;
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= width; c++)
      cells.push((row.getCell(c).text ?? "").trim()); // .text keeps long account numbers as shown
    grid.push(cells);
  });
  return setSession(db, filePath.split(/[\\/]/).pop()!, grid, true);
}
export const loadPaste = (db: DB, text: string, hasHeader: boolean) =>
  setSession(
    db,
    "Pasted cells",
    parseTsv(String(text).slice(0, 5_000_000)),
    hasHeader,
  );

function readRows(mapping: ColumnMapping) {
  if (!session) throw new Error("Nothing loaded. Start the import again.");
  const core = ACCOUNT_KEYS as readonly string[];
  if (
    !Array.isArray(mapping) ||
    mapping.length !== session.headers.length ||
    mapping.some((k) => k !== null && !core.includes(k) && !isCustomKey(k))
  )
    throw new Error("Invalid mapping");
  const picked = mapping.filter(Boolean) as string[];
  if (new Set(picked).size !== picked.length)
    throw new Error("Two columns map to the same field");
  if (!picked.includes("payee"))
    throw new Error("Map at least the Beneficiary column");

  return session.rows.map(({ n, cells }) => {
    const v: Record<string, string> = {};
    mapping.forEach((k, i) => {
      if (k) v[k] = cells[i] ?? "";
    });
    const a = {
      payee: (v.payee ?? "").trim(),
      bank: (v.bank ?? "").trim(),
      branch: (v.branch ?? "").trim(),
      account_no: (v.account_no ?? "").replace(/\s/g, ""),
      ifsc: cleanIfsc(v.ifsc ?? ""),
      remarks: (v.remarks ?? "").trim(),
    };
    const extra: Record<string, string> = {};
    for (const k of picked)
      if (isCustomKey(k) && v[k]?.trim()) extra[k] = v[k].trim();

    const issues: string[] = [];
    if (!a.payee) issues.push("Missing beneficiary");
    if (a.ifsc && !isValidIfsc(a.ifsc)) issues.push("Invalid IFSC");
    return { n, v, a, extra, issues };
  });
}

// ---------- grouped analysis (one record per account number, like the transaction import) ----------
export interface MasterAccountItem {
  key: string; // account number, or "#<row>" for a row without one
  account_no: string;
  payee: string;
  rows: number[];
  rowCount: number;
  isNew: boolean; // false = already in master
  differs: boolean; // existing account whose details differ from the file
  fields: FieldConflict[];
  similar?: string; // new account that looks like one already stored / earlier in the file
}
export interface MasterAnalysis {
  total: number;
  fresh: number; // accounts to add
  existing: number; // accounts already in master
  unchanged: number; // existing accounts the file does not change
  noAccountNo: number; // rows without an account number (each is its own account)
  similar: number;
  invalidCount: number;
  invalid: ImportProblem[];
  items: MasterAccountItem[]; // only accounts needing a look: conflicts, differences or a similar match
}

interface Group {
  key: string;
  account_no: string;
  rows: number[];
  values: Record<AccField | "remarks", string>;
  extra: Record<string, string>;
  seen: SeenMap;
  existing: any | null;
}

function groupRows(db: DB, mapping: ColumnMapping) {
  const rows = readRows(mapping);
  const getMaster = db.prepare(
    "SELECT id, payee, bank, branch, ifsc, remarks, extra FROM accounts WHERE in_master = 1 AND account_no = ? LIMIT 1",
  );
  const groups = new Map<string, Group>();
  const invalid: typeof rows = [];
  for (const r of rows) {
    if (r.issues.length) {
      invalid.push(r);
      continue;
    }
    const key = r.a.account_no || `#${r.n}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        account_no: r.a.account_no,
        rows: [],
        values: { payee: "", bank: "", branch: "", ifsc: "", remarks: "" },
        extra: {},
        seen: newSeen(),
        existing: r.a.account_no
          ? ((getMaster.get(r.a.account_no) as any) ?? null)
          : null,
      };
      groups.set(key, g);
    }
    g.rows.push(r.n);
    for (const [f] of COMPARE) {
      if (!r.a[f]) continue;
      if (!g.values[f]) g.values[f] = r.a[f];
      addSeen(g.seen, f, r.a[f], r.n);
    }
    if (r.a.remarks && !g.values.remarks) g.values.remarks = r.a.remarks;
    for (const [k, val] of Object.entries(r.extra))
      if (!(k in g.extra)) g.extra[k] = val;
  }
  return { total: rows.length, groups: [...groups.values()], invalid };
}

/** New accounts (no stored match by account number) whose name + IFSC match a stored account or an earlier row of the file. */
function similarNotes(db: DB, groups: Group[]): Map<string, string> {
  const q = db.prepare(
    "SELECT payee, bank, branch, account_no FROM accounts WHERE in_master = 1 AND lower(payee) = lower(?) AND ifsc = ? LIMIT 1",
  );
  const seen = new Set<string>();
  const out = new Map<string, string>();
  for (const g of groups) {
    if (g.existing || !g.values.ifsc) continue;
    const sk = g.values.payee.toLowerCase() + "|" + g.values.ifsc;
    const soft = q.get(g.values.payee, g.values.ifsc) as any;
    if (soft)
      out.set(
        g.key,
        [
          soft.payee,
          soft.bank,
          soft.branch,
          soft.account_no ? `A/c ${soft.account_no}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
    else if (seen.has(sk)) out.set(g.key, "Earlier row in this file");
    seen.add(sk);
  }
  return out;
}

export function analyze(db: DB, mapping: ColumnMapping): MasterAnalysis {
  const { total, groups, invalid } = groupRows(db, mapping);
  const notes = similarNotes(db, groups);
  const items: MasterAccountItem[] = [];
  let fresh = 0,
    existing = 0,
    unchanged = 0,
    noAccountNo = 0;

  for (const g of groups) {
    const fields = buildFields(g.seen, g.values, g.existing ?? undefined);
    let differs = false;
    if (g.existing) {
      existing++;
      differs = !!(
        COMPARE.some(
          ([f]) => g.values[f] && !same(g.values[f], g.existing[f]),
        ) ||
        (g.values.remarks && !same(g.values.remarks, g.existing.remarks))
      );
      if (!differs) unchanged++;
    } else {
      fresh++;
      if (!g.account_no) noAccountNo++;
    }
    const note = notes.get(g.key);
    if (fields.length || note)
      items.push({
        key: g.key,
        account_no: g.account_no,
        payee: g.values.payee,
        rows: g.rows.slice(0, 20),
        rowCount: g.rows.length,
        isNew: !g.existing,
        differs,
        fields,
        similar: note,
      });
  }

  return {
    total,
    fresh,
    existing,
    unchanged,
    noAccountNo,
    similar: notes.size,
    invalidCount: invalid.length,
    invalid: invalid.slice(0, 200).map((r) => ({
      row: r.n,
      status: "invalid" as const,
      issues: r.issues,
      values: r.v,
    })),
    items,
  };
}

// ---------- grouped commit: one record per account number ----------
export interface MasterCommitOptions {
  existingRule?: "keep" | "update"; // for accounts already in master; default keep
  similarRule?: "add" | "skip"; // for new accounts that look like existing ones; default skip
  decisions?: Record<string, "keep" | "update" | "add" | "skip">; // per account (key = account number, or "#<row>")
  fieldChoices?: Record<string, Partial<Record<AccField, string>>>; // key -> field -> chosen value
}
export interface MasterCommitResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  invalid: number;
}

export function commitPlan(
  db: DB,
  mapping: ColumnMapping,
  opts: MasterCommitOptions,
): MasterCommitResult {
  const { groups, invalid } = groupRows(db, mapping);
  const headers = session!.headers;
  const now = new Date().toISOString();
  const rule = opts.existingRule === "update" ? "update" : "keep";
  const dec = opts.decisions ?? {};
  const sim = opts.similarRule === "add" ? "add" : "skip";
  const notes = similarNotes(db, groups);

  // only explicit picks for accounts in this file, cleaned and validated
  const keys = new Set(groups.map((g) => g.key));
  const choices = sanitizeChoices(opts.fieldChoices, keys);

  const ins = db.prepare(
    `INSERT INTO accounts (id, payee, bank, branch, account_no, ifsc, remarks, in_master, extra, created_at, updated_at)
     VALUES (@id, @payee, @bank, @branch, @account_no, @ifsc, @remarks, 1, @extra, @now, @now)`,
  );
  const upd = db.prepare(
    "UPDATE accounts SET payee=@payee, bank=@bank, branch=@branch, ifsc=@ifsc, remarks=@remarks, extra=@extra, updated_at=@now WHERE id=@id",
  );
  const saveMap = db.prepare(
    "INSERT OR REPLACE INTO import_mappings(header, field_key) VALUES (?, ?)",
  );
  const addCustom = db.prepare(
    "INSERT OR IGNORE INTO custom_fields(key, label, scope, position) VALUES (?, ?, 'account', (SELECT COALESCE(MAX(position), 0) + 1 FROM custom_fields))",
  );
  let added = 0,
    updated = 0,
    unchanged = 0,
    skipped = 0;

  db.transaction(() => {
    mapping.forEach((k, i) => {
      if (!k) return;
      saveMap.run(norm(headers[i]), k);
      if (isCustomKey(k)) addCustom.run(k, headers[i].trim() || k);
    });
    for (const g of groups) {
      const pick = choices.get(g.key);
      if (!g.existing) {
        if (notes.has(g.key) && (dec[g.key] ?? sim) === "skip") {
          skipped++;
          continue;
        }
        ins.run({
          id: randomUUID(),
          payee: g.values.payee,
          bank: g.values.bank,
          branch: g.values.branch,
          account_no: g.account_no,
          ifsc: g.values.ifsc,
          remarks: g.values.remarks,
          extra: JSON.stringify(g.extra),
          now,
          ...pick,
        });
        added++;
        continue;
      }
      const cur = g.existing;
      const ruleUpdate = (dec[g.key] ?? rule) === "update";
      const next =
        ruleUpdate || pick
          ? applyAccountUpdate(cur, g, ruleUpdate, pick)
          : null;
      if (!next) {
        unchanged++;
        continue;
      }
      upd.run({ ...next, id: cur.id, now });
      updated++;
    }
  })();
  session = null;
  return { added, updated, unchanged, skipped, invalid: invalid.length };
}

export const clearSession = () => {
  session = null;
};

export { customKey };
