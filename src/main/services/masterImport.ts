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
import {
  COMPARE,
  same,
  buildFields,
  clean,
  type FieldConflict,
  sanitizeChoices,
  applyAccountUpdate,
} from "./accountConflicts";
import {
  DAMAGED_MSG,
  ACCOUNT_SYNONYMS,
  autoMapHeaders,
  detectHeader,
  openWorkbook,
  readWorksheet,
  listSheets,
  saveHeaderMappings,
  accountWriter,
  loadAccountIndex,
  readAccountFields,
  newGroup,
  addRowToGroup,
  twinChecker,
  type AccountGroup,
  type AccountIndex,
  type StoredAccount,
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

export type HeaderMode = "auto" | "yes" | "no";

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

// The opened workbook stays in memory while the person picks a sheet; released on commit or cancel.
let book: { wb: Workbook; source: string; sheets: SheetChoice[] } | null = null;

function loadSheet(db: DB, name: string): ImportFileInfo {
  if (!book) throw new Error("Nothing loaded. Start the import again.");
  const ws = book.wb.getWorksheet(name);
  if (!ws) throw new Error("Sheet not found");
  const sheet = readWorksheet(ws);
  if (!sheet.length) throw new Error("This sheet is empty");
  const d = detectHeader(
    db,
    sheet.map((r) => r.cells),
    SYN,
    "account",
  );
  const rest = sheet.slice(d.index);
  const info = setSession(
    db,
    book.source,
    rest.map((r) => r.cells),
    d.hasHeader,
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

export const loadPaste = (db: DB, text: string, mode: HeaderMode | boolean) => {
  book = null;
  const m: HeaderMode = mode === true ? "yes" : mode === false ? "no" : mode;
  const grid = parseTsv(String(text).slice(0, 5_000_000));
  let start = 0,
    hasHeader = m === "yes";
  if (m === "auto") {
    const d = detectHeader(db, grid, SYN, "account");
    start = d.index;
    hasHeader = d.hasHeader;
  }
  return setSession(
    db,
    "Pasted cells",
    grid.slice(start),
    hasHeader,
    [],
    grid.slice(start).map((_, i) => start + i + 1),
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
    const r = readAccountFields(v, risky.includes(accCol));
    const a = r.fields;
    const extra: Record<string, string> = {};
    for (const k of picked) {
      const val = clean(v[k], 500);
      if (isCustomKey(k) && val) extra[k] = val;
    }

    const issues: string[] = [];
    if (!a.payee) issues.push("Missing beneficiary");
    if (r.noAccount) issues.push("Account number required");
    if (r.badIfsc) issues.push("Invalid IFSC");
    if (r.damaged) issues.push(DAMAGED_MSG);
    return { n, v, a, extra, issues };
  });
}

interface Group extends AccountGroup {
  key: string;
  existing: StoredAccount | null;
}

function groupRows(db: DB, mapping: ColumnMapping) {
  const rows = readRows(mapping);
  const index = loadAccountIndex(db);
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
      g = { ...newGroup(key), key, existing: index.byNo.get(key) ?? null };
      groups.set(key, g);
    }
    addRowToGroup(g, r.a, r.n);
    for (const [k, val] of Object.entries(r.extra))
      if (!(k in g.extra)) g.extra[k] = val;
  }
  return { total: rows.length, groups: [...groups.values()], invalid, index };
}

/** New accounts whose name + IFSC match a stored account (one-offs included) or an earlier new account in the file. */
function similarNotes(
  index: AccountIndex,
  groups: Group[],
): Map<string, string> {
  const twinOf = twinChecker(index);
  const out = new Map<string, string>();
  for (const g of groups) {
    if (g.existing) continue;
    const like = twinOf(g.values.payee, g.values.ifsc, g.account_no);
    if (!like) continue;
    const s = like.stored;
    out.set(
      g.key,
      s
        ? [s.payee, s.bank, s.branch, s.account_no ? `A/c ${s.account_no}` : ""]
            .filter(Boolean)
            .join(" · ")
        : "Earlier row in this file",
    );
  }
  return out;
}

export function analyze(db: DB, mapping: ColumnMapping): MasterAnalysis {
  const { total, groups, invalid, index } = groupRows(db, mapping);
  const notes = similarNotes(index, groups);
  const items: MasterAccountItem[] = [];
  let fresh = 0,
    existing = 0,
    unchanged = 0,
    promote = 0;

  for (const g of groups) {
    const fields = buildFields(g.seen, g.values, g.existing ?? undefined);
    const ex = g.existing;
    let differs = false;
    if (ex) {
      existing++;
      if (ex.in_master === 0) promote++;
      differs = !!(
        COMPARE.some(([f]) => g.values[f] && !same(g.values[f], ex[f])) ||
        (g.values.remarks && !same(g.values.remarks, ex.remarks))
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
  const { groups, invalid, index } = groupRows(db, mapping);
  const headers = session!.headers;
  const now = new Date().toISOString();
  const rule = opts.existingRule === "update" ? "update" : "keep";
  const dec = opts.decisions ?? {};
  const sim = opts.similarRule === "add" ? "add" : "skip";
  const notes = similarNotes(index, groups);

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
