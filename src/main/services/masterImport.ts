import { randomUUID } from "crypto";
import type { DB } from "../db";
import type { Workbook } from "exceljs";
import {
  ACCOUNT_KEYS,
  customKey,
  isCustomKey,
  type AccountKey,
  type ColumnMapping,
  type CustomColumn,
  type ImportFileInfo,
  type ImportProblem,
  type MasterAccountItem,
  type MasterAnalysis,
  type MasterCommitOptions,
  type MasterCommitResult,
  type SheetChoice,
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
import {
  isDamagedText,
  DAMAGED_MSG,
  cleanAccountNo,
  ACCOUNT_SYNONYMS,
  autoMapHeaders,
  findHeaderRow,
  openWorkbook,
  readWorksheet,
  listSheets,
  saveHeaderMappings,
  accountFinder,
  accountWriter,
} from "./importCore";

const SYNONYMS: Record<AccountKey, string[]> = {
  ...ACCOUNT_SYNONYMS,
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
  rows: { n: number; cells: string[]; risky: number[] }[]; // risky = columns Excel has already damaged
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
  return {
    mapping: autoMapHeaders(db, headers, SYN, ACCOUNT_KEYS, "account"),
    customFields,
  };
}

function setSession(
  db: DB,
  source: string,
  grid: string[][],
  hasHeader: boolean,
  risk: boolean[][] = [],
  rowNums: number[] = [],
): ImportFileInfo {
  const width = Math.max(0, ...grid.map((r) => r.length));
  const pad = (r: string[]) =>
    Array.from({ length: width }, (_, i) => r[i] ?? "");
  const headers = hasHeader
    ? pad(grid[0]).map((h, i) => h || `Column ${i + 1}`)
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const body = hasHeader ? grid.slice(1) : grid;
  const bodyRisk = hasHeader ? risk.slice(1) : risk;
  const bodyNums = hasHeader ? rowNums.slice(1) : rowNums;
  const rows = body
    .map((cells, i) => ({
      n: bodyNums[i] ?? i + (hasHeader ? 2 : 1),
      cells: pad(cells),
      risky: (bodyRisk[i] ?? []).flatMap((x, c) => (x ? [c] : [])),
    }))
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

const findHeaderIndex = (db: DB, grid: string[][]) =>
  findHeaderRow(db, grid, SYN, "account");

// The opened workbook stays in memory while the person picks a sheet; released on commit or cancel.
let book: { wb: Workbook; source: string; sheets: SheetChoice[] } | null = null;

function loadSheet(db: DB, name: string): ImportFileInfo {
  if (!book) throw new Error("Nothing loaded. Start the import again.");
  const ws = book.wb.getWorksheet(name);
  if (!ws) throw new Error("Sheet not found");
  const sheet = readWorksheet(ws);
  if (!sheet.length) throw new Error("This sheet is empty");
  const hi = findHeaderIndex(
    db,
    sheet.map((r) => r.cells),
  );
  const rest = sheet.slice(hi);
  const info = setSession(
    db,
    book.source,
    rest.map((r) => r.cells),
    true,
    rest.map((r) => r.cells.map((_, c) => r.risky.includes(c))),
    rest.map((r) => r.n),
  );
  return { ...info, sheet: name, sheets: book.sheets };
}

export async function loadFile(
  db: DB,
  filePath: string,
): Promise<ImportFileInfo> {
  const wb = await openWorkbook(filePath);
  const sheets = listSheets(db, wb, SYN, "account");
  book = { wb, source: filePath.split(/[\\/]/).pop()!, sheets };
  return loadSheet(db, (sheets.find((s) => s.recommended) ?? sheets[0]).name);
}

export const selectSheet = (db: DB, name: string) => loadSheet(db, name);

export const loadPaste = (db: DB, text: string, hasHeader: boolean) => {
  book = null;
  return setSession(
    db,
    "Pasted cells",
    parseTsv(String(text).slice(0, 5_000_000)),
    hasHeader,
  );
};

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

  const accCol = mapping.indexOf("account_no");
  return session.rows.map(({ n, cells, risky }) => {
    const v: Record<string, string> = {};
    mapping.forEach((k, i) => {
      if (k) v[k] = cells[i] ?? "";
    });
    const a = {
      payee: (v.payee ?? "").trim(),
      bank: (v.bank ?? "").trim(),
      branch: (v.branch ?? "").trim(),
      account_no: cleanAccountNo(v.account_no),
      ifsc: cleanIfsc(v.ifsc ?? ""),
      remarks: (v.remarks ?? "").trim(),
    };
    const extra: Record<string, string> = {};
    for (const k of picked)
      if (isCustomKey(k) && v[k]?.trim()) extra[k] = v[k].trim();

    const issues: string[] = [];
    if (!a.payee) issues.push("Missing beneficiary");
    if (!a.account_no) issues.push("Account number required");
    if (a.ifsc && !isValidIfsc(a.ifsc)) issues.push("Invalid IFSC");
    if (a.account_no && (risky.includes(accCol) || isDamagedText(a.account_no)))
      issues.push(DAMAGED_MSG);
    return { n, v, a, extra, issues };
  });
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
  const find = accountFinder(db);
  const groups = new Map<string, Group>();
  const invalid: typeof rows = [];
  for (const r of rows) {
    if (r.issues.length) {
      invalid.push(r);
      continue;
    }
    const key = r.a.account_no;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        account_no: r.a.account_no,
        rows: [],
        values: { payee: "", bank: "", branch: "", ifsc: "", remarks: "" },
        extra: {},
        seen: newSeen(),
        existing: find(r.a.account_no),
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
    promote = 0;

  for (const g of groups) {
    const fields = buildFields(g.seen, g.values, g.existing ?? undefined);
    let differs = false;
    if (g.existing) {
      existing++;
      if (g.existing.in_master === 0) promote++;
      differs = !!(
        COMPARE.some(
          ([f]) => g.values[f] && !same(g.values[f], g.existing[f]),
        ) ||
        (g.values.remarks && !same(g.values.remarks, g.existing.remarks))
      );
      if (!differs) unchanged++;
    } else {
      fresh++;
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
    promote,
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

  const writer = accountWriter(db);
  const addCustom = db.prepare(
    "INSERT OR IGNORE INTO custom_fields(key, label, scope, position) VALUES (?, ?, 'account', (SELECT COALESCE(MAX(position), 0) + 1 FROM custom_fields))",
  );
  let added = 0,
    updated = 0,
    unchanged = 0,
    skipped = 0;

  db.transaction(() => {
    saveHeaderMappings(db, headers, mapping);
    mapping.forEach((k, i) => {
      if (k && isCustomKey(k)) addCustom.run(k, headers[i].trim() || k);
    });
    for (const g of groups) {
      const pick = choices.get(g.key);
      if (!g.existing) {
        if (notes.has(g.key) && (dec[g.key] ?? sim) === "skip") {
          skipped++;
          continue;
        }
        writer.insert({
          id: randomUUID(),
          payee: g.values.payee,
          bank: g.values.bank,
          branch: g.values.branch,
          account_no: g.account_no,
          ifsc: g.values.ifsc,
          remarks: g.values.remarks,
          in_master: 1,
          extra: JSON.stringify(g.extra),
          now,
          batch: null, // identifies the import batch
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
      const promote = cur.in_master === 0; // a one-off account joins the list
      if (!next && !promote) {
        unchanged++;
        continue;
      }
      const base = next ?? {
        payee: cur.payee,
        bank: cur.bank,
        branch: cur.branch,
        ifsc: cur.ifsc,
        remarks: cur.remarks,
        extra: cur.extra,
      };
      writer.update({ ...base, in_master: 1, id: cur.id, now });
      updated++;
    }
  })();
  session = null;
  book = null;
  return { added, updated, unchanged, skipped, invalid: invalid.length };
}

export const clearSession = () => {
  session = null;
  book = null;
};

export { customKey };
