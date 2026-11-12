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
import AskDialog from "@/components/AskDialog";
import AccountConflictCard from "../components/AccountConflictCard";
import MappingTable from "../components/MappingTable";
import SheetPicker from "../components/SheetPicker";
import { useAccountChoices } from "../lib/useAccountChoices";

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
  look_alike: "Looks like an existing account",
};
const isAmt = (k: Kind): k is AmountKind =>
  k === "zero_amount" || k === "high_value";
const MAX_ROWS = 300; // rows beyond this follow the bulk rules; keeps the dialog fast
const num = (x: number) => x.toLocaleString("en-IN");

/** Transactions import: choose file -> match columns -> review (bulk rules + exceptions only) -> import. */
export default function TxImportDialog({
  labels,
  masterName = "Master",
  onClose,
}: {
  labels: Labels;
  masterName?: string;
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
  const [showRejected, setShowRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [repeat, setRepeat] = useState<TxImportFileInfo | null>(null); // a file imported before, waiting for the person's choice
  const [err, setErr] = useState("");
  const [result, setResult] = useState<TxImportResult | null>(null);

  const {
    dec,
    fc,
    setDecision,
    setChoice,
    reset: resetChoices,
  } = useAccountChoices<Decision>();

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
      if (r.ok) loaded(r.data!);
      else if (r.error !== "Cancelled")
        setErr(r.error ?? "Could not read the file");
    });

  const proceed = (i: TxImportFileInfo) => {
    setInfo(i);
    setMapping(i.mapping);
    setAn(null);
    setStep("map");
  };

  const loaded = (i: TxImportFileInfo) => {
    if (i.alreadyImported)
      setRepeat(i); // ask first; the column step opens only after "Continue anyway"
    else proceed(i);
  };

  const changeSheet = (name: string) =>
    guard(async () => {
      const r = await window.api.txImport.selectSheet(name);
      if (r.ok) loaded(r.data!);
      else setErr(r.error ?? "Could not read this sheet");
    });

  const check = () =>
    guard(async () => {
      const r = await window.api.txImport.analyze(mapping);
      if (!r.ok) return setErr(r.error ?? "Check failed");
      setAn(r.data!);
      resetChoices();
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

  const changeMapping = (m: ColumnMapping) => {
    setMapping(m);
    setAn(null);
  };

  const missing = REQUIRED.filter((k) => !mapping.includes(k));

  const toggleKind = (k: AmountKind) =>
    setKinds((s) => {
      const c = new Set(s);
      c.has(k) ? c.delete(k) : c.add(k);
      return c;
    });

  const exc = an?.exceptions ?? [];

  const txExc = exc.filter((e) => isAmt(e.kind));

  const likeExc = exc.filter((e) => e.kind === "look_alike");

  const count = useMemo(() => {
    const c: Record<Kind, number> = {
      master_diff: 0,
      file_conflict: 0,
      zero_amount: 0,
      high_value: 0,
      look_alike: 0,
    };
    for (const e of exc) c[e.kind]++;
    return c;
  }, [exc]);

  const accGroups = useMemo(() => {
    const m = new Map<string, AccGroup>();
    for (const e of exc) {
      if (isAmt(e.kind) || e.kind === "look_alike") continue;
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

  const skippedLike = likeExc.filter((e) => dec[e.id] === "skip");
  const skippedNos = new Set(skippedLike.map((e) => e.account_no));
  const likeRows = skippedLike.reduce((s, e) => s + e.rowCount, 0);

  const blocked = exc.filter(
    (e) =>
      isAmt(e.kind) &&
      !skippedNos.has(e.account_no) &&
      !(
        dec[e.id] === "import" ||
        (dec[e.id] !== "skip" && kinds.has(e.kind as AmountKind))
      ),
  ).length;

  const willImport = an
    ? an.transactions.fresh -
      blocked -
      likeRows +
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
                    {e.kind === "look_alike" && (
                      <select
                        value={dec[e.id] ?? ""}
                        onChange={(ev) => setDecision(e.id, ev.target.value)}
                      >
                        <option value="">Add as a new account</option>
                        <option value="skip">Skip these rows</option>
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
    <>
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
              The sheet with the most compatible column names is chosen for you,
              and you can change it on the next screen. Title or blank rows
              above the column names are skipped automatically.
            </p>
            <p className="muted">
              Needed columns: {REQUIRED.map((k) => labels[k]).join(", ")}. Each
              row becomes one transaction; its account is added to your accounts
              if it is not there yet. Rows without an account number are
              skipped.
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
            <SheetPicker
              sheets={info.sheets}
              value={info.sheet}
              disabled={busy}
              onChange={changeSheet}
            />
            <MappingTable
              headers={info.headers}
              mapping={mapping}
              onChange={changeMapping}
              fields={CORE.map((k) => ({ key: k, label: optionLabel(k) }))}
              custom={custom}
            />
            {missing.length > 0 && (
              <p className="error" style={{ marginTop: 8 }}>
                Still to match: {missing.map((k) => labels[k]).join(", ")}
              </p>
            )}
            {!mapping.includes("entry_date") && (
              <p className="muted" style={{ marginTop: 8 }}>
                No {labels.entry_date} column matched: every transaction will
                get today’s date.
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
                  {num(an.transactions.exists)} already saved in Transactions
                </span>
              )}
              <span className="chip">{num(an.accounts.new)} new accounts</span>
              <span className="chip">
                {num(an.accounts.existing)} accounts already saved
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
                    {an.accounts.new > 0
                      ? `New accounts in this file (${num(an.accounts.new)})`
                      : "Accounts in this file saved earlier as one-off"}
                    {an.accounts.oneOffExisting > 0
                      ? ` · ${num(an.accounts.oneOffExisting)} saved earlier as one-off (not in suggestions) follow this choice too`
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
                      Add to {masterName} (used for suggestions)
                    </option>
                    <option value="oneoff">
                      Use for these transactions only (not added to {masterName}{" "}
                      or suggestions)
                    </option>
                  </select>
                </div>
              )}
              {count.master_diff > 0 && (
                <div className="field" style={{ maxWidth: 560 }}>
                  <label>
                    Accounts already saved whose details differ in this file (
                    {num(count.master_diff)}): name, bank, branch or IFSC
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
                      Keep the saved details (recommended)
                    </option>
                    <option value="update">
                      Replace with the file's details (also shows on their older
                      transactions)
                    </option>
                  </select>
                </div>
              )}
              {an.transactions.exists > 0 && (
                <div className="field" style={{ maxWidth: 560 }}>
                  <label>
                    Rows in this file that match a transaction already saved in
                    the app ({num(an.transactions.exists)}): same account,
                    amount, date and reference
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
                    <option value="skip">
                      Skip them, don't add duplicates (recommended)
                    </option>
                    <option value="import">
                      Add them again as new transactions
                    </option>
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
                count.high_value === 0 &&
                count.look_alike === 0 && (
                  <p className="muted">
                    Nothing needs a decision. Everything in the file is clean.
                  </p>
                )}
            </div>

            {excTable(
              likeExc,
              "Possible account number typos → Accounts table",
              "same name and IFSC as an account already saved, under a different account number",
            )}

            <AccountConflictCard
              items={accGroups.map((g) => ({
                key: g.no,
                account_no: g.no,
                payee: g.payee,
                rows: g.rows,
                rowCount: g.rowCount,
                decisionKey: g.diffId,
                fields: [...g.fields.values()],
              }))}
              rule={opt.masterDiff}
              decisions={dec}
              onDecision={setDecision}
              choices={fc}
              onChoice={setChoice}
              title="Account details → Accounts table"
              hint="pick the value to store where the file or master disagree"
              maxItems={MAX_ROWS}
            />

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
                  <div
                    style={{ maxHeight: 240, overflow: "auto", marginTop: 8 }}
                  >
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
            <p className="muted" style={{ margin: "0 0 6px" }}>
              Transactions
            </p>
            <div className="chips">
              <span className={result.txAdded > 0 ? "chip ok" : "chip"}>
                {num(result.txAdded)} added
              </span>
              {result.txSkippedExisting > 0 && (
                <span className="chip">
                  {num(result.txSkippedExisting)} skipped: already saved
                </span>
              )}
              {result.txSkippedUnconfirmed > 0 && (
                <span className="chip warn">
                  {num(result.txSkippedUnconfirmed)} skipped: zero or
                  high-value, not confirmed
                </span>
              )}
              {result.txSkippedLookAlike > 0 && (
                <span className="chip warn">
                  {num(result.txSkippedLookAlike)} skipped: look-alike account
                </span>
              )}
            </div>
            <p className="muted" style={{ margin: "12px 0 6px" }}>
              Accounts
            </p>
            <div className="chips">
              <span className={result.accountsAdded > 0 ? "chip ok" : "chip"}>
                {num(result.accountsAdded)} added
              </span>
              <span className="chip">
                {num(result.accountsUpdated)} updated
              </span>
              {result.accountsPromoted > 0 && (
                <span className="chip">
                  {num(result.accountsPromoted)} moved to {masterName}
                </span>
              )}
            </div>
            <p className="muted" style={{ marginTop: 12 }}>
              Made a mistake? Use “Undo last import” on the Transactions
              toolbar.
            </p>
          </div>
        )}
        {err && <p className="error">{err}</p>}
      </Modal>

      {repeat?.alreadyImported && (
        <AskDialog
          title="Import this file again?"
          confirmLabel="Continue anyway"
          onResult={(ok) => {
            const i = repeat;
            setRepeat(null);
            if (ok && i) proceed(i);
            else {
              window.api.txImport.cancel();
              setInfo(null);
              setAn(null);
              setStep("pick");
            }
          }}
        >
          <p>
            This data was already imported on{" "}
            <b>{new Date(repeat.alreadyImported.on).toLocaleString("en-IN")}</b>
            {repeat.alreadyImported.file !== repeat.source
              ? ` (as ${repeat.alreadyImported.file})`
              : ""}
            .
          </p>
          <p>Continuing only adds transactions that are not already saved.</p>
        </AskDialog>
      )}
    </>
  );
}
