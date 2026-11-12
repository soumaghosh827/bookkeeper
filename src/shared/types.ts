// Single source of truth for fields and for the API the renderer may call (mirrored in preload + ipc).
// Internal keys never change; labels are editable (field_labels table).

export const FIELD_KEYS = [
  "payee",
  "account_no",
  "bank",
  "branch",
  "ifsc",
  "remarks", // master (accounts)
  "reference_no",
  "entry_date",
  "amount_paise",
  "utr",
  "notes", // transactions
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];
export type Labels = Record<FieldKey, string>;

export const DEFAULT_LABELS: Labels = {
  payee: "Beneficiary",
  account_no: "Account No",
  bank: "Bank Name",
  branch: "Branch",
  ifsc: "IFSC Code",
  remarks: "Remarks",
  reference_no: "Reference No",
  entry_date: "Date",
  amount_paise: "Amount",
  utr: "UTR No",
  notes: "Notes",
};

export const ACCOUNT_KEYS = [
  "payee",
  "account_no",
  "bank",
  "branch",
  "ifsc",
  "remarks",
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];
export const SEARCH_KEYS = [
  "payee",
  "account_no",
  "bank",
  "branch",
  "ifsc",
] as const; // fields with suggestions
export type SearchKey = (typeof SEARCH_KEYS)[number];

// Transaction table column order (ref no first, then date, then the rest) and which cells can be edited there.
export const TX_COLUMNS = [
  "reference_no",
  "entry_date",
  "payee",
  "bank",
  "branch",
  "account_no",
  "ifsc",
  "amount_paise",
  "utr",
  "notes",
] as const;
export const TX_EDITABLE: readonly string[] = ["utr", "notes"];

export const customKey = (header: string) =>
  "x_" +
  (header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "col");
export const isCustomKey = (k: string) => /^x_[a-z0-9_]+$/.test(k);

export type Scope = "account" | "transaction";
export interface CustomColumn {
  key: string;
  label: string;
  scope: Scope;
  position: number;
  archived: boolean;
}

export type AppState = "no-vault" | "locked" | "unlocked";

export type ConfirmKind =
  | "zero"
  | "duplicate"
  | "highValue"
  | "duplicateAccount"
  | "similarAccount";
export type Confirmations = Partial<Record<ConfirmKind, boolean>>;

export interface Result<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
  needs?: ConfirmKind[]; // nothing saved; UI must ask the user, then resend with these confirmations set
  existing?: Account[]; // records behind duplicateAccount / similarAccount
  field?: string; // column key that caused the error
}

export interface Account {
  id: string;
  payee: string;
  bank: string;
  branch: string;
  account_no: string;
  ifsc: string;
  remarks: string;
  in_master: boolean;
  use_count: number;
  last_used_at: string | null;
  last_amount_paise: number | null;
  extra: string;
  created_at: string;
  updated_at: string;
}
export interface AccountInput {
  payee: string;
  bank: string;
  branch: string;
  account_no: string;
  ifsc: string;
  remarks: string;
  extra?: Record<string, string>;
}

export interface TxRow {
  uid: string;
  account_id: string;
  payee: string;
  bank: string;
  branch: string;
  account_no: string;
  ifsc: string;
  amount_paise: number;
  reference_no: string;
  utr: string;
  notes: string;
  entry_date: string;
  extra: string;
  created_at: string;
  updated_at: string;
  report_count: number;
  in_preview: number;
}
export interface TxCreate {
  account_id?: string | null; // picked from master
  account?: AccountInput & { save_to_master: boolean }; // or typed by hand
  amount_paise: number;
  reference_no: string;
  entry_date: string;
  utr: string;
  notes: string;
  extra?: Record<string, string>;
  add_to_preview?: boolean;
}

export type TxChanges = Partial<
  Pick<TxRow, "reference_no" | "entry_date" | "amount_paise" | "utr" | "notes">
> & { extra?: Record<string, string> };

export interface TxHistoryEntry {
  at: string;
  action: "create" | "update" | "delete";
  changes: Record<string, [unknown, unknown]>;
  reason: string | null;
}

export interface PreviewRow {
  uid: string;
  position: number;
  payee: string;
  amount_paise: number;
  reference_no: string;
  created_at: string;
  report_count: number;
}

export interface GridQuery {
  q?: string;
  filters: Record<string, string>;
  sort?: { key: string; dir: "asc" | "desc" } | null;
  limit: number;
  offset: number;
  oneOff?: boolean; // accounts only: show one-off (not-in-master) accounts
}
export interface GridPage<T> {
  rows: T[];
  total: number;
  sumPaise?: number;
}

// ---- master import (Excel file or pasted cells) ----
export type ColumnMapping = (string | null)[]; // account key, custom key ('x_...') or null = skip

/** How pasted cells are read: "auto" finds the header row itself, "yes" = first row is the header, "no" = no header row. */
export type HeaderMode = "auto" | "yes" | "no";
export interface ImportFileInfo {
  source: string;
  sheet?: string; // Excel files only (not pasted cells)
  sheets?: SheetChoice[];
  headers: string[];
  rowCount: number;
  mapping: ColumnMapping;
  customFields: CustomColumn[];
  alreadyImported: { on: string; file: string } | null; // the same data was imported before (and not undone)
}
export interface ImportProblem {
  row: number;
  status: "invalid" | "duplicate" | "similar";
  issues: string[];
  values: Record<string, string>;
  existing?: string;
}
export interface MasterAccountItem {
  key: string; // account number
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
  fresh: number;
  existing: number;
  unchanged: number;
  promote: number; // existing one-off accounts that will be added to the list
  similar: number;
  invalidCount: number;
  invalid: ImportProblem[];
  items: MasterAccountItem[];
}
export interface MasterCommitOptions {
  existingRule?: "keep" | "update";
  similarRule?: "add" | "skip";
  decisions?: Record<string, "keep" | "update" | "add" | "skip">; // per account key
  fieldChoices?: Record<string, Partial<Record<AccField, string>>>; // account key -> field -> chosen value
}
export interface MasterCommitResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  invalid: number;
}
// ---- transactions import (one Excel file fills accounts and transactions) ----
export interface SheetChoice {
  name: string;
  hidden: boolean;
  score: number; // distinct known columns found in the sheet's best header row
  recommended: boolean; // the sheet with the most compatible headers
}
export interface TxImportFileInfo {
  source: string;
  sheet: string; // sheet currently loaded
  sheets: SheetChoice[]; // every sheet: visible first, hidden last
  headers: string[];
  rowCount: number;
  headerRow: number; // Excel row the column names were found in
  mapping: ColumnMapping;
  alreadyImported: { on: string; file: string } | null; // the same data was imported before (and not undone)
}
export interface TxImportRejected {
  row: number;
  reason: string;
  values: Record<string, string>;
}

// ---------- import matching (decisions about rows that look like an already saved transaction) ----------
/** ref_link: the file row has a reference, the saved transaction has none.
 *  blank_match: the file row has no reference.
 *  file_twin: same key, and same reference (or both blank), as an earlier row of the same file. */
export type TxMatchKind = "ref_link" | "blank_match" | "file_twin";
/** link = add the file's reference to the saved transaction (no new transaction); new = import as a separate transaction; skip = ignore the row. */
export type TxMatchChoice = "link" | "new" | "skip";

export const MATCH_RECOMMENDED: Record<TxMatchKind, TxMatchChoice> = {
  ref_link: "link",
  blank_match: "skip",
  file_twin: "new",
};
/** Choices offered per kind, the recommended one first. A blank row has no reference to add, so it cannot "link". */
export const MATCH_CHOICES: Record<TxMatchKind, TxMatchChoice[]> = {
  ref_link: ["link", "new", "skip"],
  blank_match: ["skip", "new"],
  file_twin: ["new", "skip"],
};
/** What a file row was paired with: a saved transaction, or an earlier row of the same file. */
export type TxMatchTarget =
  | { type: "saved"; uid: string; refs: string[]; created_at: string }
  | { type: "file"; row: number; ref: string }; // Excel row of the earlier file row, and its reference ("" = none)
export interface TxMatchRow {
  row: number; // Excel row of the file transaction
  kind: TxMatchKind;
  account_no: string;
  payee: string;
  amount_paise: number;
  entry_date: string; // ISO
  fileRef: string; // "" = the file row has no reference
  target: TxMatchTarget; // what the row was paired with: a saved transaction or an earlier row of this file
}

export type TxImportExceptionKind =
  | "master_diff"
  | "file_conflict"
  | "zero_amount"
  | "high_value"
  | "look_alike";

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
export interface TxImportException {
  id: string; // decisions are keyed by this id
  kind: TxImportExceptionKind;
  rows: number[]; // Excel row numbers (first 20)
  rowCount: number;
  account_no: string;
  payee: string;
  detail: string;
  fields?: FieldConflict[];
}
export interface TxImportAnalysis {
  total: number;
  dateMode: "column" | "today"; // 'today' = no date column mapped
  accounts: { new: number; existing: number; oneOffExisting: number };
  transactions: { fresh: number; exists: number };
  rejectedCount: number;
  rejected: TxImportRejected[]; // first 200
  exceptions: TxImportException[];
  matches: TxMatchRow[]; // file rows that look like a saved transaction and need a decision (recommended action is the default)
  linkedSame: number; // file rows that are the same saved transaction (shared reference): nothing new is added
  infoTwins: number; // rows with the same key but a different reference than another transaction (saved or in-file): kept, no decision
}
export interface TxImportOptions {
  newAccounts: "master" | "oneoff";
  masterDiff: "keep" | "update";
  confirmKinds?: ("zero_amount" | "high_value")[];
  decisions?: Record<string, "import" | "skip" | "update" | "keep">;
  matchDefaults?: Partial<Record<TxMatchKind, TxMatchChoice>>; // bulk choice per kind
  matchChoices?: Record<string, TxMatchChoice>; // per-row override, keyed by Excel row number
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
  txSkippedLookAlike: number;
  refsLinked: number; // references added to existing transactions
  txSkippedMatched: number; // file rows skipped because they matched a saved transaction
}
export interface TxUndoInfo {
  id: number;
  kind: "tx" | "master";
  created_at: string;
  file_name: string;
  transactions: number;
  edited: number;
  newAccounts: number;
  inReports: number;
  canUndo: boolean;
}
export interface TxUndoResult {
  transactions: number;
  accountsRemoved: number;
  accountsKept: number;
  reverted: number;
  revertSkipped: number;
}

// ---- templates & reports ----
export interface Template {
  id: number;
  name: string;
  description: string;
  has_file: boolean;
  updated_at: string;
  format: string; // short output summary, e.g. "1 page" or "Letter only + Excel"
}
export interface TemplateText {
  key: string;
  value: string;
}

export interface ReportFile {
  id: string; // matches OutputSpec.id
  kind: "docx" | "xlsx";
  fileName: string; // default name incl. extension; the user may edit it before saving
}

export interface ReportPrepared {
  fileName: string; // first file's name
  files: ReportFile[];
  templateName: string;
  count: number;
  total_paise: number;
}

// ---- report output plan: per template, stored as JSON in templates.output_plan ----
export const TABLE_COLUMN_KEYS = [
  "sno",
  "payee",
  "bank",
  "branch",
  "account_no",
  "ifsc",
  "amount",
  "reference_no",
  "date",
  "utr",
  "notes",
] as const;
export type TableColumnKey = (typeof TABLE_COLUMN_KEYS)[number];
export interface TableColumn {
  key: TableColumnKey;
  header: string;
  on: boolean;
} // array order = column order in the table
// 'inline' = at the {@table} marker (or at the end if the Word file has none); 'new_page' = page break first; 'none' = no table.
// For xlsx outputs the table is the whole sheet, so it is always 'inline'.
export type TablePlacement = "inline" | "new_page" | "none";
export interface OutputSpec {
  id: string;
  kind: "docx" | "xlsx";
  name: string;
  table: TablePlacement;
} // name = file name pattern: {template} {date}
export interface OutputPlan {
  columns: TableColumn[];
  totalLabel: string;
  outputs: OutputSpec[];
}

export const DEFAULT_COLUMNS: readonly TableColumn[] = [
  { key: "sno", header: "Sl. No.", on: true },
  { key: "payee", header: "Beneficiary Name", on: true },
  { key: "bank", header: "BANK", on: true },
  { key: "branch", header: "BRANCH", on: true },
  { key: "account_no", header: "ACCOUNT NUMBER", on: true },
  { key: "ifsc", header: "IFS Code", on: true },
  { key: "amount", header: "Amount(Rs.)", on: true },
  { key: "reference_no", header: "Reference No", on: false },
  { key: "date", header: "Date", on: false },
  { key: "utr", header: "UTR No", on: false },
  { key: "notes", header: "Notes", on: false },
];
export const DEFAULT_FILE_NAME = "{template} {date}";
export const DEFAULT_PLAN: OutputPlan = {
  columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
  totalLabel: "GRAND TOTAL (Rs.)",
  outputs: [
    { id: "o1", kind: "docx", name: DEFAULT_FILE_NAME, table: "inline" },
  ],
};

/** Short, human label for what a template produces. Order follows the plan's outputs. */
export function describePlan(plan: OutputPlan): string {
  const parts = plan.outputs.map((o) =>
    o.kind === "xlsx"
      ? "Excel"
      : o.table === "new_page"
        ? "Table on page 2"
        : o.table === "none"
          ? "Letter only"
          : "1 page",
  );
  return parts.length ? parts.join(" + ") : "No output";
}

const str = (v: unknown, max: number, fallback: string) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback;

/** Turns whatever is stored (empty, old, hand-edited, corrupt) into a valid plan. Use it on every read and before every save. */
export function normalizePlan(raw: unknown): OutputPlan {
  let p: any = raw;
  if (typeof raw === "string") {
    try {
      p = JSON.parse(raw);
    } catch {
      p = null;
    }
  }
  if (!p || typeof p !== "object") p = {};

  const seen = new Set<string>();
  let columns: TableColumn[] = [];
  for (const c of Array.isArray(p.columns) ? p.columns : []) {
    if (
      !c ||
      !(TABLE_COLUMN_KEYS as readonly string[]).includes(c.key) ||
      seen.has(c.key)
    )
      continue;
    seen.add(c.key);
    columns.push({
      key: c.key,
      header: str(
        c.header,
        40,
        DEFAULT_COLUMNS.find((d) => d.key === c.key)!.header,
      ),
      on: c.key === "amount" || c.on === true,
    }); // amount is always on: the total needs it
  }
  if (!columns.length) columns = DEFAULT_COLUMNS.map((c) => ({ ...c }));
  else
    for (const d of DEFAULT_COLUMNS)
      if (!seen.has(d.key)) columns.push({ ...d, on: false }); // columns added in later versions start switched off

  const ids = new Set<string>();
  const outputs: OutputSpec[] = [];
  for (const o of Array.isArray(p.outputs) ? p.outputs.slice(0, 4) : []) {
    if (!o || (o.kind !== "docx" && o.kind !== "xlsx")) continue;
    let id = str(o.id, 20, "o" + (outputs.length + 1));
    while (ids.has(id)) id += "_";
    ids.add(id);
    const table: TablePlacement =
      o.kind === "xlsx"
        ? "inline"
        : o.table === "new_page" || o.table === "none"
          ? o.table
          : "inline";
    outputs.push({
      id,
      kind: o.kind,
      name: str(o.name, 100, DEFAULT_FILE_NAME),
      table,
    });
  }
  return {
    columns,
    totalLabel: str(p.totalLabel, 40, DEFAULT_PLAN.totalLabel),
    outputs: outputs.length
      ? outputs
      : DEFAULT_PLAN.outputs.map((o) => ({ ...o })),
  };
}

export const PREF_KEYS = [
  "master_name",
  "theme",
  "density",
  "tx_columns",
  "last_template",
] as const;
export type PrefKey = (typeof PREF_KEYS)[number];

// The ONLY surface the renderer can call.
export interface BookkeeperApi {
  vault: {
    state(): Promise<AppState>;
    create(password: string): Promise<Result<{ recoveryKey: string }>>;
    unlock(password: string): Promise<Result>;
    unlockWithRecoveryKey(
      recoveryKey: string,
      newPassword: string,
    ): Promise<Result>;
    lock(): Promise<void>;
  };
  labels: {
    get(): Promise<Labels>;
    set(key: FieldKey, label: string): Promise<Result>;
  };
  prefs: {
    get(key: PrefKey): Promise<string | null>;
    set(key: PrefKey, value: string): Promise<Result>;
  };
  backup: { create(): Promise<Result<{ path: string }>> };
  accounts: {
    search(field: SearchKey, text: string): Promise<Account[]>;
    list(q: GridQuery): Promise<GridPage<Account>>;
    create(a: AccountInput, confirm?: Confirmations): Promise<Result<Account>>;
    update(
      id: string,
      changes: Partial<AccountInput>,
      confirm?: Confirmations,
    ): Promise<Result<Account>>;
  };
  masterImport: {
    pickFile(): Promise<Result<ImportFileInfo>>;
    selectSheet(name: string): Promise<Result<ImportFileInfo>>;
    loadPaste(text: string, mode: HeaderMode): Promise<Result<ImportFileInfo>>;
    analyze(mapping: ColumnMapping): Promise<Result<MasterAnalysis>>;
    commitPlan(
      mapping: ColumnMapping,
      opts: MasterCommitOptions,
    ): Promise<Result<MasterCommitResult>>;
  };
  txImport: {
    pickFile(): Promise<Result<TxImportFileInfo>>;
    selectSheet(name: string): Promise<Result<TxImportFileInfo>>;
    analyze(mapping: ColumnMapping): Promise<Result<TxImportAnalysis>>;
    commit(opts: TxImportOptions): Promise<Result<TxImportResult>>;
    cancel(): Promise<void>;
    undoInfo(): Promise<TxUndoInfo | null>;
    undoLast(): Promise<Result<TxUndoResult>>;
  };
  transactions: {
    create(t: TxCreate, confirm?: Confirmations): Promise<Result<TxRow>>;
    update(
      uid: string,
      changes: TxChanges,
      confirm?: Confirmations,
    ): Promise<Result<TxRow>>;
    correct(
      uid: string,
      changes: Pick<TxChanges, "amount_paise" | "entry_date" | "reference_no">,
      confirm?: Confirmations,
      auth?: { password?: string; reason?: string },
    ): Promise<Result<TxRow>>;
    history(uid: string): Promise<TxHistoryEntry[]>;
    remove(uid: string): Promise<Result>;
    list(q: GridQuery): Promise<GridPage<TxRow>>;
    exportXlsx(q: GridQuery): Promise<Result<{ path: string; rows: number }>>;
  };
  customColumns: {
    list(scope: Scope, includeArchived?: boolean): Promise<CustomColumn[]>;
    add(scope: Scope, label: string): Promise<Result<CustomColumn>>;
    rename(key: string, label: string): Promise<Result<CustomColumn>>;
    archive(key: string, archived: boolean): Promise<Result>;
    reorder(scope: Scope, keys: string[]): Promise<Result>;
  };
  preview: {
    list(): Promise<PreviewRow[]>;
    add(uids: string[], at?: number): Promise<Result<{ added: number }>>;
    remove(uid: string): Promise<Result>;
    clear(): Promise<Result>;
  };
  templates: {
    list(): Promise<Template[]>;
    save(t: {
      id?: number;
      name: string;
      description: string;
    }): Promise<Result<Template>>;
    uploadFile(id: number): Promise<Result<Template>>;
    remove(id: number): Promise<Result>;
    getTexts(id: number): Promise<TemplateText[]>;
    setTexts(id: number, texts: TemplateText[]): Promise<Result>;
    getPlan(id: number): Promise<OutputPlan>;
    setPlan(id: number, plan: OutputPlan): Promise<Result<OutputPlan>>;
  };
  reports: {
    prepare(
      templateId: number,
      uids: string[],
      title?: string,
    ): Promise<Result<ReportPrepared>>;
    save(
      record: boolean,
      names?: Record<string, string>, // output id -> edited file name
    ): Promise<Result<{ path: string }>>; // one file: Save-As dialog; several: folder picker. Error 'Cancelled' keeps the prepared report
    discard(): Promise<void>;
  };
}
