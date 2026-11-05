import { useEffect, useMemo, useState } from "react";
import type {
  AccField,
  ColumnMapping,
  CustomColumn,
  FieldConflict,
  Labels,
  TxImportAnalysis,
  TxImportException,
  TxImportFileInfo,
  TxImportOptions,
  TxImportResult,
} from "@shared/types";
import Modal from "@/components/Modal";

type Step = "pick" | "map" | "review" | "done";
type Kind = TxImportException["kind"];
type AmountKind = "zero_amount" | "high_value";
type Decision = NonNullable<TxImportOptions["decisions"]>[string];
type AccGroup = {
  no: string;
  payee: string;
  rows: number[];
  rowCount: number;
  diffId?: string; // set when the account already exists and differs from the file
  fields: Map<AccField, FieldConflict>;
};

const nk = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase(); // same equality the backend uses

const topOf = (f: FieldConflict) => {
  const file = f.candidates
    .filter((c) => c.source === "file")
    .sort((a, b) => b.count - a.count);
  return file.length > 1 && file[0].count > file[1].count
    ? file[0].value
    : null;
};

const CORE = [
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
const REQUIRED = ["payee", "account_no", "amount_paise"] as const;
const KIND_LABEL: Record<Kind, string> = {
  master_diff: "Differs from master",
  file_conflict: "Conflict inside the file",
  zero_amount: "Zero amount",
  high_value: "High value",
};
const isAmt = (k: Kind): k is AmountKind =>
  k === "zero_amount" || k === "high_value";
const MAX_ROWS = 300; // rows beyond this follow the bulk rules; keeps the dialog fast
const num = (x: number) => x.toLocaleString("en-IN");

/** Transactions import: choose file -> match columns -> review (bulk rules + exceptions only) -> import. */
export default function TxImportDialog({
  labels,
  onClose,
}: {
  labels: Labels;
  onClose: (changed: boolean) => void;
}) {
  const [step, setStep] = useState<Step>("pick");
  const [info, setInfo] = useState<TxImportFileInfo | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [custom, setCustom] = useState<CustomColumn[]>([]);
  const [an, setAn] = useState<TxImportAnalysis | null>(null);
  const [opt, setOpt] = useState<
    Pick<TxImportOptions, "newAccounts" | "masterDiff" | "existingTx">
  >({ newAccounts: "master", masterDiff: "keep", existingTx: "skip" });
  const [kinds, setKinds] = useState<Set<AmountKind>>(new Set());
  const [dec, setDec] = useState<Record<string, Decision>>({});
  // explicit picks only: account_no -> field -> chosen value. Untouched fields follow the default/bulk rule.
  const [fc, setFc] = useState<
    Record<string, Partial<Record<AccField, string>>>
  >({});
  const [showRejected, setShowRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<TxImportResult | null>(null);

  useEffect(() => {
    Promise.all([
      window.api.customColumns.list("account"),
      window.api.customColumns.list("transaction"),
    ]).then(([a, t]) => setCustom([...a, ...t]));
    return () => {
      window.api.txImport.cancel();
    }; // the loaded file never outlives the dialog
  }, []);

  const guard = async (fn: () => Promise<void>) => {
    setErr("");
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    window.api.txImport.cancel();
    onClose(step === "done");
  };

  const pickFile = () =>
    guard(async () => {
      const r = await window.api.txImport.pickFile();
      if (r.ok) {
        setInfo(r.data!);
        setMapping(r.data!.mapping);
        setAn(null);
        setStep("map");
      } else if (r.error !== "Cancelled")
        setErr(r.error ?? "Could not read the file");
    });
  const check = () =>
    guard(async () => {
      const r = await window.api.txImport.analyze(mapping);
      if (!r.ok) return setErr(r.error ?? "Check failed");
      setAn(r.data!);
      setDec({});
      setFc({});
      setKinds(new Set());
      setShowRejected(false);
      setStep("review");
    });
  const doImport = () =>
    guard(async () => {
      const r = await window.api.txImport.commit({
        ...opt,
        confirmKinds: [...kinds],
        decisions: dec,
        fieldChoices: fc,
      });
      if (r.ok) {
        setResult(r.data!);
        setStep("done");
      } else setErr(r.error ?? "Import failed");
    });

  // choosing a field for one column frees it from any other column
  const setCol = (i: number, v: string) => {
    setMapping((m) =>
      m.map((x, j) => (j === i ? v || null : v && x === v ? null : x)),
    );
    setAn(null);
  };

  const missing = REQUIRED.filter((k) => !mapping.includes(k));

  const toggleKind = (k: AmountKind) =>
    setKinds((s) => {
      const c = new Set(s);
      c.has(k) ? c.delete(k) : c.add(k);
      return c;
    });

  const setDecision = (id: string, v: string) =>
    setDec((d) => {
      const c = { ...d };
      if (v) c[id] = v as Decision;
      else delete c[id];
      return c;
    });

  const setChoice = (accNo: string, field: AccField, value: string) =>
    setFc((s) => {
      const acc = { ...(s[accNo] ?? {}) };
      if (value) acc[field] = value;
      else delete acc[field];
      const next = { ...s };
      if (Object.keys(acc).length) next[accNo] = acc;
      else delete next[accNo];
      return next;
    });

  const exc = an?.exceptions ?? [];

  const txExc = exc.filter((e) => isAmt(e.kind));

  const count = useMemo(() => {
    const c: Record<Kind, number> = {
      master_diff: 0,
      file_conflict: 0,
      zero_amount: 0,
      high_value: 0,
    };
    for (const e of exc) c[e.kind]++;
    return c;
  }, [exc]);

  const accGroups = useMemo(() => {
    const m = new Map<string, AccGroup>();
    for (const e of exc) {
      if (isAmt(e.kind)) continue;
      let g = m.get(e.account_no);
      if (!g) {
        g = {
          no: e.account_no,
          payee: e.payee,
          rows: e.rows,
          rowCount: e.rowCount,
          fields: new Map(),
        };
        m.set(e.account_no, g);
      }
      if (e.kind === "master_diff") g.diffId = e.id;
      for (const f of e.fields ?? []) g.fields.set(f.field, f);
    }
    return [...m.values()];
  }, [exc]);

  const blocked = exc.filter(
    (e) =>
      isAmt(e.kind) &&
      !(
        dec[e.id] === "import" ||
        (dec[e.id] !== "skip" && kinds.has(e.kind as AmountKind))
      ),
  ).length;

  const willImport = an
    ? an.transactions.fresh -
      blocked +
      (opt.existingTx === "import" ? an.transactions.exists : 0)
    : 0;

  const optionLabel = (k: (typeof CORE)[number]) =>
    k === "remarks"
      ? `${labels.remarks} (of the account)`
      : k === "notes"
        ? `${labels.notes} (of this transaction)`
        : labels[k];

  const excTable = (list: TxImportException[], title: string, hint: string) =>
    list.length > 0 && (
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>
          {title} <small>· {hint}</small>
        </h3>
        <div style={{ maxHeight: 280, overflow: "auto" }}>
          <table className="maptable">
            <thead>
              <tr>
                <th>Type</th>
                <th>{labels.account_no}</th>
                <th>{labels.payee}</th>
                <th>Detail</th>
                <th>Rows</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, MAX_ROWS).map((e) => (
                <tr key={e.id}>
                  <td>{KIND_LABEL[e.kind]}</td>
                  <td className="mono">{e.account_no}</td>
                  <td>{e.payee}</td>
                  <td>{e.detail}</td>
                  <td>
                    {e.rows.join(", ")}
                    {e.rowCount > e.rows.length
                      ? ` +${e.rowCount - e.rows.length}`
                      : ""}
                  </td>
                  <td>
                    {e.kind === "master_diff" && (
                      <select
                        value={dec[e.id] ?? ""}
                        onChange={(ev) => setDecision(e.id, ev.target.value)}
                      >
                        <option value="">Follow the rule</option>
                        <option value="keep">Keep existing</option>
                        <option value="update">Update from file</option>
                      </select>
                    )}
                    {isAmt(e.kind) && (
                      <select
                        value={dec[e.id] ?? ""}
                        onChange={(ev) => setDecision(e.id, ev.target.value)}
                      >
                        <option value="">Follow the tick</option>
                        <option value="import">Import</option>
                        <option value="skip">Skip</option>
                      </select>
                    )}
                    {e.kind === "file_conflict" && (
                      <span className="muted">First value used</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.length > MAX_ROWS && (
          <p className="muted" style={{ marginTop: 6 }}>
            Showing the first {MAX_ROWS} of {num(list.length)}. The rest follow
            the rules above.
          </p>
        )}
      </div>
    );

  // what the account keeps if the user touches nothing
  const defaultOf = (g: AccGroup, f: FieldConflict) =>
    g.diffId && (dec[g.diffId] ?? opt.masterDiff) !== "update"
      ? f.current
      : f.defaultValue;
  const chosenOf = (g: AccGroup, f: FieldConflict) =>
    fc[g.no]?.[f.field] ?? defaultOf(g, f);
  const pickValue = (g: AccGroup, f: FieldConflict, v: string) =>
    setChoice(g.no, f.field, nk(v) === nk(defaultOf(g, f)) ? "" : v); // only real deviations are stored
  const candNote = (
    f: FieldConflict,
    c: FieldConflict["candidates"][number],
  ) => {
    const parts: string[] = [];
    if (c.source === "file")
      parts.push(
        `${c.count} row${c.count > 1 ? "s" : ""}: ${c.rows.slice(0, 3).join(", ")}${c.rows.length > 3 ? "…" : ""}`,
      );
    if (c.source === "master" || (f.current && nk(c.value) === nk(f.current)))
      parts.push("current in master");
    if (c.value === topOf(f)) parts.push("most common");
    return parts.length ? ` (${parts.join(" · ")})` : "";
  };

  const accountCard = accGroups.length > 0 && (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>
        Account details → Accounts table{" "}
        <small>
          · pick the value to store where the file or master disagree
        </small>
      </h3>
      <div style={{ maxHeight: 380, overflow: "auto" }}>
        {accGroups.slice(0, MAX_ROWS).map((g) => {
          const fields = [...g.fields.values()];
          return (
            <div
              key={g.no}
              style={{
                padding: "8px 0",
                borderBottom: "1px solid rgba(128,128,128,.3)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <b className="mono">{g.no}</b>
                <span>{g.payee}</span>
                <span className="muted">
                  rows {g.rows.join(", ")}
                  {g.rowCount > g.rows.length
                    ? ` +${g.rowCount - g.rows.length}`
                    : ""}
                </span>
                {g.diffId && (
                  <select
                    value={dec[g.diffId!] ?? ""}
                    onChange={(ev) => setDecision(g.diffId!, ev.target.value)}
                  >
                    <option value="">Account in master: follow the rule</option>
                    <option value="keep">
                      Account in master: keep existing
                    </option>
                    <option value="update">
                      Account in master: update from file
                    </option>
                  </select>
                )}
              </div>
              {fields.map((f) => (
                <div
                  key={f.field}
                  style={{
                    display: "flex",
                    gap: 14,
                    flexWrap: "wrap",
                    marginTop: 4,
                  }}
                >
                  <span style={{ width: 90 }}>{f.label}</span>
                  {defaultOf(g, f) === "" && (
                    <label>
                      <input
                        type="radio"
                        name={`${g.no}:${f.field}`}
                        checked={chosenOf(g, f) === ""}
                        onChange={() => setChoice(g.no, f.field, "")}
                      />{" "}
                      (empty)
                    </label>
                  )}
                  {f.candidates.map((c) => (
                    <label key={c.source + c.value}>
                      <input
                        type="radio"
                        name={`${g.no}:${f.field}`}
                        checked={nk(chosenOf(g, f)) === nk(c.value)}
                        onChange={() => pickValue(g, f, c.value)}
                      />{" "}
                      {c.value}
                      <small className="muted">{candNote(f, c)}</small>
                    </label>
                  ))}
                </div>
              ))}
              <div className="muted" style={{ marginTop: 4 }}>
                Will be saved:{" "}
                {fields
                  .map((f) => `${f.label}: ${chosenOf(g, f) || "(empty)"}`)
                  .join(" · ")}
              </div>
            </div>
          );
        })}
      </div>
      {accGroups.length > MAX_ROWS && (
        <p className="muted" style={{ marginTop: 6 }}>
          Showing the first {MAX_ROWS} of {num(accGroups.length)}. The rest
          follow the rules above.
        </p>
      )}
    </div>
  );

  const actions =
    step === "pick" ? (
      <button onClick={close}>Cancel</button>
    ) : step === "map" ? (
      <>
        <button onClick={close}>Cancel</button>
        <button
          onClick={() => {
            setStep("pick");
            setAn(null);
          }}
        >
          Choose another file
        </button>
        <button
          className="primary"
          disabled={busy || missing.length > 0}
          onClick={check}
        >
          Check file
        </button>
      </>
    ) : step === "review" ? (
      <>
        <button onClick={close}>Cancel</button>
        <button onClick={() => setStep("map")}>Back to columns</button>
        <button
          className="primary"
          disabled={busy || willImport === 0}
          onClick={doImport}
        >
          Import {num(willImport)} transactions
        </button>
      </>
    ) : (
      <button className="primary" onClick={close}>
        Close
      </button>
    );

  return (
    <Modal
      title="Import transactions from Excel"
      wide
      onClose={busy ? undefined : close}
      actions={actions}
    >
      {step === "pick" && (
        <div className="card">
          <h3>Choose the Excel file</h3>
          <p className="muted">
            The first sheet is read. Title or blank rows above the column names
            are skipped automatically.
          </p>
          <p className="muted">
            Needed columns: {REQUIRED.map((k) => labels[k]).join(", ")}. Each
            row becomes one transaction; its account is added to your accounts
            if it is not there yet. Rows without an account number are skipped.
          </p>
          <button className="primary" disabled={busy} onClick={pickFile}>
            Choose Excel file…
          </button>
        </div>
      )}

      {step === "map" && info && (
        <div className="card">
          <h3>
            Match columns{" "}
            <small>
              · {info.source} · {num(info.rowCount)} rows
              {info.headerRow > 1
                ? ` · column names found in row ${info.headerRow}`
                : ""}
            </small>
          </h3>
          <table className="maptable">
            <thead>
              <tr>
                <th>Column in your file</th>
                <th>Goes to</th>
              </tr>
            </thead>
            <tbody>
              {info.headers.map((h, i) => (
                <tr key={i}>
                  <td>
                    <strong>{h}</strong>
                  </td>
                  <td>
                    <select
                      value={mapping[i] ?? ""}
                      onChange={(e) => setCol(i, e.target.value)}
                    >
                      <option value="">Skip this column</option>
                      {CORE.map((k) => (
                        <option key={k} value={k}>
                          {optionLabel(k)}
                        </option>
                      ))}
                      {custom.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label} (custom)
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {missing.length > 0 && (
            <p className="error" style={{ marginTop: 8 }}>
              Still to match: {missing.map((k) => labels[k]).join(", ")}
            </p>
          )}
          {!mapping.includes("entry_date") && (
            <p className="muted" style={{ marginTop: 8 }}>
              No {labels.entry_date} column matched: every transaction will get
              today’s date.
            </p>
          )}
        </div>
      )}

      {step === "review" && an && (
        <>
          <div className="chips" style={{ marginBottom: 12 }}>
            <span className="chip ok">
              {num(an.transactions.fresh)} new transactions
            </span>
            {an.transactions.exists > 0 && (
              <span className="chip warn">
                {num(an.transactions.exists)} already in the database
              </span>
            )}
            <span className="chip">{num(an.accounts.new)} new accounts</span>
            <span className="chip">
              {num(an.accounts.existing)} existing accounts
            </span>
            {an.transactions.twinGroups > 0 && (
              <span className="chip">
                {num(an.transactions.twinGroups)} sets of identical rows (all
                kept)
              </span>
            )}
            {an.rejectedCount > 0 && (
              <span className="chip bad">
                {num(an.rejectedCount)} rows rejected
              </span>
            )}
          </div>
          {an.dateMode === "today" && (
            <div className="notice" style={{ marginBottom: 12 }}>
              No date column was matched, so every transaction gets today’s
              date.
            </div>
          )}

          <div className="card" style={{ marginBottom: 12 }}>
            <h3>What should happen</h3>
            {(an.accounts.new > 0 || an.accounts.oneOffExisting > 0) && (
              <div className="field" style={{ maxWidth: 560 }}>
                <label>
                  New accounts ({num(an.accounts.new)})
                  {an.accounts.oneOffExisting > 0
                    ? ` · ${num(an.accounts.oneOffExisting)} one-off accounts in the file follow the same choice`
                    : ""}
                </label>
                <select
                  value={opt.newAccounts}
                  onChange={(e) =>
                    setOpt({
                      ...opt,
                      newAccounts: e.target
                        .value as TxImportOptions["newAccounts"],
                    })
                  }
                >
                  <option value="master">
                    Add to the accounts list used for suggestions
                  </option>
                  <option value="oneoff">
                    Keep as one-off accounts only (no suggestions)
                  </option>
                </select>
              </div>
            )}
            {count.master_diff > 0 && (
              <div className="field" style={{ maxWidth: 560 }}>
                <label>
                  Existing accounts whose details differ in the file (
                  {num(count.master_diff)})
                </label>
                <select
                  value={opt.masterDiff}
                  onChange={(e) =>
                    setOpt({
                      ...opt,
                      masterDiff: e.target
                        .value as TxImportOptions["masterDiff"],
                    })
                  }
                >
                  <option value="keep">
                    Keep the existing details (recommended)
                  </option>
                  <option value="update">
                    Update them from the file (changes all their transactions)
                  </option>
                </select>
              </div>
            )}
            {an.transactions.exists > 0 && (
              <div className="field" style={{ maxWidth: 560 }}>
                <label>
                  Rows already in the database ({num(an.transactions.exists)}):
                  same account, amount, date and reference
                </label>
                <select
                  value={opt.existingTx}
                  onChange={(e) =>
                    setOpt({
                      ...opt,
                      existingTx: e.target
                        .value as TxImportOptions["existingTx"],
                    })
                  }
                >
                  <option value="skip">Skip them (recommended)</option>
                  <option value="import">Import them anyway</option>
                </select>
              </div>
            )}
            {count.zero_amount > 0 && (
              <label
                className="check"
                style={{ display: "flex", marginBottom: 6 }}
              >
                <input
                  type="checkbox"
                  checked={kinds.has("zero_amount")}
                  onChange={() => toggleKind("zero_amount")}
                />{" "}
                Import the {num(count.zero_amount)} rows with a zero amount
              </label>
            )}
            {count.high_value > 0 && (
              <label
                className="check"
                style={{ display: "flex", marginBottom: 6 }}
              >
                <input
                  type="checkbox"
                  checked={kinds.has("high_value")}
                  onChange={() => toggleKind("high_value")}
                />{" "}
                Import the {num(count.high_value)} rows of ₹1 Cr or more
              </label>
            )}
            {an.accounts.new === 0 &&
              count.master_diff === 0 &&
              an.transactions.exists === 0 &&
              count.zero_amount === 0 &&
              count.high_value === 0 && (
                <p className="muted">
                  Nothing needs a decision. Everything in the file is clean.
                </p>
              )}
          </div>

          {accountCard}

          {excTable(
            txExc,
            "Transaction checks → Transactions table",
            "change a single row here; all others follow the ticks above",
          )}

          {an.rejectedCount > 0 && (
            <div className="card">
              <h3>
                Rejected rows{" "}
                <small>· {num(an.rejectedCount)} will not be imported</small>
              </h3>
              <p className="muted">
                Fix them in Excel and import the file again. Rows already
                imported are recognised and skipped.
              </p>
              <button
                className="small"
                onClick={() => setShowRejected((s) => !s)}
              >
                {showRejected ? "Hide list" : "Show list"}
              </button>
              {showRejected && (
                <div style={{ maxHeight: 240, overflow: "auto", marginTop: 8 }}>
                  <table className="maptable">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Reason</th>
                        <th>{labels.payee}</th>
                        <th>{labels.account_no}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {an.rejected.map((r) => (
                        <tr key={r.row}>
                          <td>{r.row}</td>
                          <td className="error">{r.reason}</td>
                          <td>{r.values.payee}</td>
                          <td className="mono">{r.values.account_no}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {an.rejectedCount > an.rejected.length && (
                <p className="muted" style={{ marginTop: 6 }}>
                  Showing the first {an.rejected.length}.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {step === "done" && result && (
        <div className="card">
          <h3>Import finished</h3>
          <div className="chips">
            <span className="chip ok">
              {num(result.txAdded)} transactions added
            </span>
            {result.accountsAdded > 0 && (
              <span className="chip ok">
                {num(result.accountsAdded)} accounts added
              </span>
            )}
            {result.accountsUpdated > 0 && (
              <span className="chip">
                {num(result.accountsUpdated)} accounts updated
              </span>
            )}
            {result.accountsPromoted > 0 && (
              <span className="chip">
                {num(result.accountsPromoted)} one-off accounts moved to the
                list
              </span>
            )}
            {result.txSkippedExisting > 0 && (
              <span className="chip">
                {num(result.txSkippedExisting)} already existed
              </span>
            )}
            {result.txSkippedUnconfirmed > 0 && (
              <span className="chip warn">
                {num(result.txSkippedUnconfirmed)} not confirmed, skipped
              </span>
            )}
          </div>
          <p className="muted" style={{ marginTop: 12 }}>
            Made a mistake? Use “Undo last import” on the Transactions toolbar.
          </p>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </Modal>
  );
}
