import { useState } from "react";
import {
  ACCOUNT_KEYS,
  customKey,
  type ColumnMapping,
  type ImportFileInfo,
  type Labels,
  type MasterAnalysis,
} from "@shared/types";
import AccountConflictCard from "../components/AccountConflictCard";
import { useAccountChoices } from "../lib/useAccountChoices";

type Step = "source" | "map" | "done";

/** Master import: Excel file or pasted cells -> map columns -> check rows (duplicates flagged) -> import. */
export default function ImportPanel({
  labels,
  masterName,
  onClose,
}: {
  labels: Labels;
  masterName: string;
  onClose: (changed: boolean) => void;
}) {
  const [step, setStep] = useState<Step>("source");
  const [text, setText] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [info, setInfo] = useState<ImportFileInfo | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [an, setAn] = useState<MasterAnalysis | null>(null);
  const [rule, setRule] = useState<"keep" | "update">("keep");
  const [simRule, setSimRule] = useState<"add" | "skip">("skip");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{
    added: number;
    updated: number;
    unchanged: number;
    skipped: number;
    invalid: number;
  } | null>(null);

  const {
    dec,
    fc,
    setDecision,
    setChoice,
    reset: resetChoices,
  } = useAccountChoices();

  const loaded = (i: ImportFileInfo) => {
    setInfo(i);
    setMapping(i.mapping);
    setAn(null);
    setStep("map");
  };
  const guard = async (fn: () => Promise<void>) => {
    setErr("");
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const pickFile = () =>
    guard(async () => {
      const r = await window.api.masterImport.pickFile();
      if (r.ok) loaded(r.data!);
      else if (r.error !== "Cancelled")
        setErr(r.error ?? "Could not read the file");
    });
  const usePaste = () =>
    guard(async () => {
      const r = await window.api.masterImport.loadPaste(text, hasHeader);
      r.ok ? loaded(r.data!) : setErr(r.error ?? "Nothing to import");
    });
  const check = () =>
    guard(async () => {
      const r = await window.api.masterImport.analyze(mapping);
      if (r.ok) {
        setAn(r.data!);
        resetChoices();
      } else setErr(r.error ?? "Check failed");
    });
  const doImport = () =>
    guard(async () => {
      const r = await window.api.masterImport.commitPlan(mapping, {
        existingRule: rule,
        similarRule: simRule,
        decisions: dec as Record<string, "keep" | "update" | "add" | "skip">,
        fieldChoices: fc,
      });
      if (r.ok) {
        setResult(r.data!);
        setStep("done");
      } else setErr(r.error ?? "Import failed");
    });
  const setCol = (i: number, v: string) => {
    setMapping((m) => m.map((x, j) => (j === i ? v || null : x)));
    setAn(null);
  };
  const skipCount = an
    ? an.items.filter((i) => i.similar && (dec[i.key] ?? simRule) === "skip")
        .length
    : 0;
  const addCount = an ? an.fresh - skipCount : 0;
  const canUpdate =
    !!an &&
    an.existing > an.unchanged &&
    (rule === "update" || Object.values(dec).includes("update"));

  return (
    <div className={`import${an ? " is-review" : ""}`}>
      <div className="toolbar">
        <h2>Import into {masterName}</h2>
        <span className="grow" />
        <button onClick={() => onClose(step === "done")}>
          {step === "done" ? "Close" : "Cancel"}
        </button>
      </div>

      {step === "source" && (
        <>
          <div className="card">
            <h3>From an Excel file</h3>
            <p className="muted">
              The first sheet is read. The first row must be the header row.
            </p>
            <button className="primary" disabled={busy} onClick={pickFile}>
              Choose Excel file…
            </button>
          </div>
          <div className="card">
            <h3>Paste from Excel</h3>
            <p className="muted">
              Copy cells in Excel (Ctrl+C) and paste here (Ctrl+V). Use this for
              a first load or to add a few accounts later.
            </p>
            <textarea
              className="pastebox"
              placeholder="Paste cells here…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <p
              style={{
                marginTop: 8,
                display: "flex",
                gap: 16,
                alignItems: "center",
              }}
            >
              <label className="check">
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(e) => setHasHeader(e.target.checked)}
                />{" "}
                First row has column names
              </label>
              <button
                className="primary"
                disabled={busy || !text.trim()}
                onClick={usePaste}
              >
                Continue
              </button>
            </p>
            {!hasHeader && (
              <p className="muted">
                Without names, columns are read in this order:{" "}
                {["payee", "bank", "branch", "account_no", "ifsc", "remarks"]
                  .map((k) => labels[k as keyof Labels])
                  .join(", ")}
                .
              </p>
            )}
          </div>
        </>
      )}

      {step === "map" && info && (
        <>
          {!an ? (
            <div className="card">
              <h3>
                Match columns{" "}
                <small>
                  · {info.source} · {info.rowCount.toLocaleString("en-IN")} rows
                </small>
              </h3>
              <table className="maptable">
                <thead>
                  <tr>
                    <th>Column in your data</th>
                    <th>Goes to</th>
                  </tr>
                </thead>
                <tbody>
                  {info.headers.map((h, i) => {
                    const newKey = customKey(h);
                    const exists = info.customFields.some(
                      (c) => c.key === newKey,
                    );
                    return (
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
                            {ACCOUNT_KEYS.map((k) => (
                              <option key={k} value={k}>
                                {labels[k]}
                              </option>
                            ))}
                            {info.customFields.map((c) => (
                              <option key={c.key} value={c.key}>
                                {c.label} (custom)
                              </option>
                            ))}
                            {!exists && (
                              <option value={newKey}>New column “{h}”</option>
                            )}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p
                style={{
                  marginTop: 12,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <button className="primary" disabled={busy} onClick={check}>
                  Check rows
                </button>
                <button
                  onClick={() => {
                    setStep("source");
                    setAn(null);
                  }}
                >
                  Back
                </button>
              </p>
            </div>
          ) : (
            <div className="imp-line">
              <span>
                <b>{info.source}</b> · {info.rowCount.toLocaleString("en-IN")}{" "}
                rows · {mapping.filter(Boolean).length} of {info.headers.length}{" "}
                columns mapped
              </span>
              <span className="grow" />
              <button onClick={() => setAn(null)}>Edit mapping</button>
            </div>
          )}

          {an && (
            <div className="imp-review">
              <div className="imp-bar">
                <div className="chips">
                  <span className="chip ok">{an.fresh} new accounts</span>
                  {an.existing > 0 && (
                    <span className="chip">
                      {an.existing} already in {masterName} ({an.unchanged} need
                      no changes)
                    </span>
                  )}
                  {an.noAccountNo > 0 && (
                    <span className="chip">
                      {an.noAccountNo} without account no
                    </span>
                  )}
                  {an.similar > 0 && (
                    <span className="chip warn">
                      {an.similar} look like an account already saved
                    </span>
                  )}
                  {an.invalidCount > 0 && (
                    <span className="chip bad">
                      {an.invalidCount} invalid (skipped)
                    </span>
                  )}
                </div>
                <div className="imp-bar-row">
                  {an.existing > an.unchanged && (
                    <label className="acc-ctl">
                      <span>
                        Already in {masterName}, but the file differs:
                      </span>
                      <select
                        value={rule}
                        onChange={(e) =>
                          setRule(e.target.value as "keep" | "update")
                        }
                      >
                        <option value="keep">Keep saved details</option>
                        <option value="update">
                          Replace with the file's details
                        </option>
                      </select>
                    </label>
                  )}
                  {an.similar > 0 && (
                    <label className="acc-ctl">
                      <span>Looks like existing:</span>
                      <select
                        value={simRule}
                        onChange={(e) =>
                          setSimRule(e.target.value as "add" | "skip")
                        }
                      >
                        <option value="skip">Skip</option>
                        <option value="add">Add as new</option>
                      </select>
                    </label>
                  )}
                  <span className="grow" />
                  {skipCount > 0 && (
                    <span className="muted">{skipCount} will be skipped</span>
                  )}
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      (addCount === 0 &&
                        !canUpdate &&
                        Object.keys(fc).length === 0)
                    }
                    onClick={doImport}
                  >
                    Import {addCount} new
                    {canUpdate
                      ? ` and update up to ${an.existing - an.unchanged}`
                      : ""}
                  </button>
                </div>
              </div>

              <AccountConflictCard
                items={an.items.map((i) => ({
                  key: i.key,
                  account_no: i.account_no,
                  payee: i.payee,
                  rows: i.rows,
                  rowCount: i.rowCount,
                  decisionKey: !i.isNew && i.differs ? i.key : undefined,
                  note: i.similar,
                  similarKey: i.similar ? i.key : undefined,
                  fields: i.fields,
                }))}
                rule={rule}
                similarRule={simRule}
                decisions={dec}
                onDecision={setDecision}
                choices={fc}
                onChoice={setChoice}
                title="Accounts needing a look"
                hint="pick the value to store where the file and master disagree"
              />

              {an.invalid.length > 0 && (
                <details className="imp-invalid">
                  <summary>Invalid rows ({an.invalidCount}) · skipped</summary>
                  <div>
                    <table className="maptable">
                      <thead>
                        <tr>
                          <th>Row</th>
                          <th>Issue</th>
                          <th>Beneficiary</th>
                          <th>Account No</th>
                        </tr>
                      </thead>
                      <tbody>
                        {an.invalid.map((p) => (
                          <tr key={p.row}>
                            <td>{p.row}</td>
                            <td>
                              <span className="error">
                                {p.issues.join(", ")}
                              </span>
                            </td>
                            <td>{p.values.payee}</td>
                            <td className="mono">{p.values.account_no}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          )}
        </>
      )}

      {step === "done" && result && (
        <div className="card">
          <h3>Import finished</h3>
          <div className="chips">
            <span className="chip ok">{result.added} added</span>
            {result.updated > 0 && (
              <span className="chip">{result.updated} updated</span>
            )}
            <span className="chip">{result.unchanged} unchanged</span>
            {result.skipped > 0 && (
              <span className="chip">
                {result.skipped} skipped (looked like existing)
              </span>
            )}
            {result.invalid > 0 && (
              <span className="chip bad">{result.invalid} invalid skipped</span>
            )}
          </div>
          <p style={{ marginTop: 12 }}>
            <button className="primary" onClick={() => onClose(true)}>
              Back to {masterName}
            </button>
          </p>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
