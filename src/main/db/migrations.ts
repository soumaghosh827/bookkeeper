// DEV PHASE: one schema, edited in place; delete the DB file after any change.
// Before the first real release: freeze this as version 1 and append-only migrations from then on.
export const migrations: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE field_labels (key TEXT PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE import_mappings (header TEXT PRIMARY KEY, field_key TEXT NOT NULL);

CREATE TABLE custom_fields (
  key      TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  scope    TEXT NOT NULL CHECK (scope IN ('account','transaction')),
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

-- MASTER: the single source of truth for payee / account / bank / branch / IFSC
CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  payee      TEXT NOT NULL,
  bank       TEXT NOT NULL DEFAULT '',
  branch     TEXT NOT NULL DEFAULT '',
  account_no TEXT NOT NULL DEFAULT '',
  ifsc       TEXT NOT NULL DEFAULT '',
  remarks    TEXT NOT NULL DEFAULT '',
  in_master  INTEGER NOT NULL DEFAULT 1,
  use_count  INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  last_amount_paise INTEGER,
  extra      TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_acc_payee  ON accounts(payee COLLATE NOCASE);
CREATE INDEX idx_acc_bank   ON accounts(bank COLLATE NOCASE);
CREATE INDEX idx_acc_branch ON accounts(branch COLLATE NOCASE);
CREATE INDEX idx_acc_no     ON accounts(account_no);
CREATE INDEX idx_acc_ifsc   ON accounts(ifsc);

-- Payee / bank / branch / account no / IFSC are read from accounts (live link), never copied here.
CREATE TABLE transactions (
  uid          TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  amount_paise INTEGER NOT NULL DEFAULT 0,
  utr          TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  entry_date   TEXT NOT NULL,
  extra        TEXT NOT NULL DEFAULT '{}',
  deleted_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_tx_date    ON transactions(entry_date);
CREATE INDEX idx_tx_amount  ON transactions(amount_paise);
CREATE INDEX idx_tx_utr     ON transactions(utr);
CREATE INDEX idx_tx_account ON transactions(account_id, entry_date);
CREATE INDEX idx_tx_created ON transactions(created_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  action TEXT NOT NULL,
  changes TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX idx_audit_row ON audit_log(row_id);

-- The "working list" on the right of the Entry screen. Survives restarts.
CREATE TABLE preview_items (
  tx_uid   TEXT PRIMARY KEY REFERENCES transactions(uid) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL
);

CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  file BLOB,
  updated_at TEXT NOT NULL
);
CREATE TABLE template_texts (
  template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (template_id, key)
);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  template_id INTEGER,
  template_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  total_paise INTEGER NOT NULL
);
CREATE TABLE report_items (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  tx_uid TEXT NOT NULL REFERENCES transactions(uid),
  PRIMARY KEY (report_id, tx_uid)
);
CREATE INDEX idx_ri_tx ON report_items(tx_uid);
`,
  },
  {
    version: 2,
    sql: `
-- Per-template "output plan" (which files to produce, table placement, table columns and headers) as JSON.
-- Stored as JSON so new report variations never need another schema change. Empty = use the app defaults.
ALTER TABLE templates ADD COLUMN output_plan TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    version: 3,
    sql: `
-- One row per import(Transactions and Accounts), so the whole import can be undone.
CREATE TABLE import_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL,
  file_name       TEXT NOT NULL DEFAULT '',
  acc_count       INTEGER NOT NULL DEFAULT 0,
  tx_count        INTEGER NOT NULL DEFAULT 0,
  account_changes TEXT NOT NULL DEFAULT '[]', -- previous values of master accounts this import updated (used by undo)
  undone_at       TEXT,
  kind            TEXT NOT NULL DEFAULT 'tx' CHECK (kind IN ('tx', 'master')),
  file_hash       TEXT NOT NULL DEFAULT ''
);
ALTER TABLE accounts     ADD COLUMN batch_id INTEGER REFERENCES import_batches(id);
ALTER TABLE transactions ADD COLUMN batch_id INTEGER REFERENCES import_batches(id);
CREATE INDEX idx_acc_batch ON accounts(batch_id);
CREATE INDEX idx_tx_batch  ON transactions(batch_id);
CREATE INDEX idx_batch_hash ON import_batches(file_hash);
`,
  },
  {
    version: 4,
    sql: `
-- One row per reference number linked to a transaction (a transaction can have many).
-- ref_key = ref_no lower-cased with all spaces removed; this is what matching and uniqueness use.
CREATE TABLE transaction_references (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL REFERENCES transactions(uid) ON DELETE CASCADE,
  ref_no         TEXT NOT NULL,
  ref_key        TEXT NOT NULL,
  report_id      INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  batch_id       INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (transaction_id, ref_key)
);
CREATE INDEX idx_txref_ref   ON transaction_references(ref_key);
CREATE INDEX idx_txref_batch ON transaction_references(batch_id);
CREATE INDEX idx_txref_report ON transaction_references(report_id);
`,
  },
];
