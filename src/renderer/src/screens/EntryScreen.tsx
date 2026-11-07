import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Account,
  CustomColumn,
  Labels,
  PreviewRow,
  ReportPrepared,
  SearchKey,
  Template,
  TxCreate,
} from "@shared/types";
import { canDelete } from "@shared/rules";
import {
  fmtDate,
  formatPaise,
  parseAmount,
  parseDate,
  rupeesInWords,
  todayIso,
} from "@shared/format";
import SuggestPanel from "@/components/SuggestPanel";
import Modal from "@/components/Modal";
import AskDialog from "@/components/AskDialog";
import NameDialog from "@/components/NameDialog";
import { Toast, useToast } from "@/components/Toast";
import { useConfirmFlow } from "@/lib/useConfirmFlow";
import TransactionsScreen from "./TransactionsScreen";

const ACC: SearchKey[] = ["payee", "bank", "branch", "account_no", "ifsc"]; // form order; each box searches only its own column
const blank = (date?: string): Record<string, string> => ({
  payee: "",
  bank: "",
  branch: "",
  account_no: "",
  ifsc: "",
  amount: "",
  entry_date: date ?? fmtDate(todayIso()),
  reference_no: "",
  utr: "",
  notes: "",
});
type Sug = {
  field: SearchKey;
  items: Account[];
  idx: number;
  text: string;
  rect: DOMRect;
};
type Report = {
  prepared: ReportPrepared;
  record: boolean;
  busy: boolean;
  saved?: string;
  err?: string;
  already: number;
  title?: string;
  names: Record<string, string>; // output id -> editable file name
};

export default function EntryScreen({
  labels,
  active,
  refreshKey,
  onTxChanged,
  onMasterChanged,
  onCount,
}: {
  labels: Labels;
  active: boolean;
  refreshKey: number;
  onTxChanged: () => void;
  onMasterChanged: () => void;
  onCount: (n: number) => void;
}) {
  const [d, setD] = useState(blank());
  const [accountId, setAccountId] = useState<string | null>(null);
  const [saveToMaster, setSaveToMaster] = useState(true);
  const [sug, setSug] = useState<Sug | null>(null);
  const [flash, setFlash] = useState(false);
  const [more, setMore] = useState(false);
  const [custom, setCustom] = useState<CustomColumn[]>([]);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [newUid, setNewUid] = useState<string | null>(null);
  const [tpls, setTpls] = useState<Template[]>([]);
  const [tplId, setTplId] = useState<number | "">("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [askClear, setAskClear] = useState(false);
  const [delRow, setDelRow] = useState<PreviewRow | null>(null);
  const [fieldDlg, setFieldDlg] = useState(false);

  const tplGroups = useMemo(() => {
    const m = new Map<string, Template[]>();
    for (const t of tpls) m.set(t.format, [...(m.get(t.format) ?? []), t]);
    return [...m.entries()];
  }, [tpls]);
  const tplSel = tpls.find((t) => t.id === tplId);

  const refCheck = useMemo(() => {
    const distinct = [
      ...new Set(rows.map((r) => r.reference_no).filter(Boolean)),
    ];
    const blank = rows.filter((r) => !r.reference_no).length;
    const shown =
      distinct.slice(0, 3).join(", ") + (distinct.length > 3 ? ", …" : "");
    let note = "";
    if (distinct.length > 1)
      note = `${distinct.length} different reference numbers${blank ? `, and ${blank} with none` : ""}. The document will print: ${shown}.`;
    else if (distinct.length === 1 && blank)
      note = `${blank} of ${rows.length} have no reference number. The document will show only: ${shown}.`;
    return { note, none: rows.length > 0 && distinct.length === 0 };
  }, [rows]);

  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const seq = useRef(0);
  const saving = useRef(false);
  const { toast, show, hide } = useToast();
  const { withConfirm, element } = useConfirmFlow();
  const locked = !!accountId;
  const total = rows.reduce((n, r) => n + r.amount_paise, 0);

  const reloadRows = useCallback(async () => {
    const r = await window.api.preview.list();
    setRows(r);
    onCount(r.length);
  }, [onCount]);
  useEffect(() => {
    reloadRows();
  }, [reloadRows, refreshKey]);
  useEffect(() => {
    window.api.customColumns.list("transaction").then(setCustom);
  }, [refreshKey]);
  useEffect(() => {
    window.api.templates.list().then(setTpls);
    window.api.prefs.get("last_template").then((v) => {
      if (v) setTplId((cur) => cur || Number(v));
    });
  }, [active, refreshKey]);
  useEffect(() => {
    if (active) setTimeout(() => refs.current.payee?.focus(), 40);
  }, [active]);
  useEffect(() => {
    if (!newUid) return;
    const t = setTimeout(() => setNewUid(null), 1500);
    return () => clearTimeout(t);
  }, [newUid]);
  useEffect(() => {
    if (tplId && !tpls.some((t) => t.id === tplId) && tpls.length) setTplId("");
  }, [tpls, tplId]);

  const fail = (m: string, key: string) => {
    show(m, { tone: "error" });
    refs.current[key]?.focus();
  };

  // ---------- suggestions: each box searches ONLY its own column ----------
  async function openSuggest(field: SearchKey, text: string, all = false) {
    const el = refs.current[field];
    if (!el || (!text.trim() && !all)) return setSug(null);
    const id = ++seq.current;
    const items = await window.api.accounts.search(field, all ? "" : text);
    if (id !== seq.current) return; // a newer keystroke already replaced this result
    setSug({
      field,
      items,
      idx: 0,
      text: all ? "" : text,
      rect: el.getBoundingClientRect(),
    });
  }
  function pick(a: Account) {
    setD((x) => ({
      ...x,
      payee: a.payee,
      bank: a.bank,
      branch: a.branch,
      account_no: a.account_no,
      ifsc: a.ifsc,
    }));
    setAccountId(a.id);
    setSug(null);
    setFlash(true);
    setTimeout(() => setFlash(false), 1300);
    refs.current.amount?.focus();
    refs.current.amount?.select();
  }
  function changeAccount() {
    setD((x) => ({
      ...x,
      payee: "",
      bank: "",
      branch: "",
      account_no: "",
      ifsc: "",
    }));
    setAccountId(null);
    setSug(null);
    refs.current.payee?.focus();
  }
  function setField(key: string, value: string) {
    setD((x) => ({
      ...x,
      [key]: key === "ifsc" ? value.toUpperCase() : value,
    }));
    if ((ACC as string[]).includes(key)) openSuggest(key as SearchKey, value);
  }

  const order = [
    "payee",
    "bank",
    "branch",
    "account_no",
    "ifsc",
    "amount",
    "entry_date",
    "reference_no",
    ...(more ? ["utr", "notes", ...custom.map((c) => c.key)] : []),
  ];
  function onKey(e: React.KeyboardEvent<HTMLInputElement>, key: string) {
    if (e.nativeEvent.isComposing) return;
    const isAcc = (ACC as string[]).includes(key);
    if (isAcc && !locked) {
      if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        openSuggest(key as SearchKey, d[key], true);
        return;
      }
      if (sug && sug.field === key) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSug({ ...sug, idx: Math.min(sug.idx + 1, sug.items.length - 1) });
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSug({ ...sug, idx: Math.max(sug.idx - 1, 0) });
          return;
        }
        if (e.key === "Enter" && sug.items.length) {
          e.preventDefault();
          pick(sug.items[sug.idx]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSug(null);
          return;
        }
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || key === "amount") return void save();
      const next = refs.current[order[order.indexOf(key) + 1]];
      if (next) {
        next.focus();
        next.select();
      } else save();
    }
  }
  function onBlur(key: string) {
    setSug((s) => (s && s.field === key ? null : s));
    if (key === "amount")
      setD((x) => {
        const a = parseAmount(x.amount);
        return a.ok && a.paise != null && x.amount.trim()
          ? { ...x, amount: formatPaise(a.paise) }
          : x;
      });
    if (key === "entry_date")
      setD((x) => {
        const iso = parseDate(x.entry_date);
        return iso ? { ...x, entry_date: fmtDate(iso) } : x;
      });
  }

  // ---------- save a transaction -> saved in DB and shown in the list on the right ----------
  async function save() {
    if (saving.current) return;
    saving.current = true;
    try {
      const payee = d.payee.trim();
      if (!accountId && !payee)
        return fail("Choose or type a beneficiary", "payee");
      const amt = parseAmount(d.amount);
      if (!amt.ok) return fail("Amount is not valid", "amount");
      const date = parseDate(d.entry_date);
      if (!date)
        return fail("Date is not valid (use dd/mm/yyyy)", "entry_date");
      const extra: Record<string, string> = {};
      for (const c of custom)
        if (d[c.key]?.trim()) extra[c.key] = d[c.key].trim();
      const input: TxCreate = {
        account_id: accountId,
        account: accountId
          ? undefined
          : {
              payee,
              bank: d.bank,
              branch: d.branch,
              account_no: d.account_no,
              ifsc: d.ifsc,
              remarks: "",
              save_to_master: saveToMaster,
            },
        amount_paise: amt.paise ?? 0,
        reference_no: d.reference_no,
        entry_date: date,
        utr: d.utr,
        notes: d.notes,
        extra,
        add_to_preview: true,
      };
      const newAccount = !accountId && saveToMaster;
      const r = await withConfirm(
        (c) => window.api.transactions.create(input, c),
        {
          payee,
          amountPaise: amt.paise ?? 0,
          existingAction: { label: "Use this account", run: pick },
        },
      );
      if (!r) {
        refs.current.amount?.focus();
        return;
      } // cancelled in the dialog
      if (!r.ok)
        return fail(
          r.error ?? "Could not save",
          r.field === "amount_paise" ? "amount" : (r.field ?? "payee"),
        );
      setNewUid(r.data!.uid);
      await reloadRows();
      onTxChanged();
      if (newAccount) onMasterChanged();
      show(`Saved ₹${formatPaise(r.data!.amount_paise)} · ${r.data!.payee}`);
      setD((x) => ({ ...blank(x.entry_date), reference_no: x.reference_no })); // date and reference no stay for the next one
      setAccountId(null);
      refs.current.payee?.focus();
    } finally {
      saving.current = false;
    }
  }

  // ---------- list on the right ----------
  async function removeRow(r: PreviewRow) {
    await window.api.preview.remove(r.uid);
    await reloadRows();
    onTxChanged();
    show(`Removed ${r.payee} from the list`, {
      actions: [
        {
          label: "Undo",
          run: async () => {
            await window.api.preview.add([r.uid], r.position);
            await reloadRows();
            onTxChanged();
          },
        },
        ...(canDelete(r.created_at)
          ? [{ label: "Delete transaction…", run: () => setDelRow(r) }]
          : []),
      ],
    });
  }
  async function deleteTx() {
    const r = delRow!;
    setDelRow(null);
    const res = await window.api.transactions.remove(r.uid);
    if (!res.ok)
      return show(res.error ?? "Could not delete", { tone: "error" });
    await reloadRows();
    onTxChanged();
    show("Transaction deleted");
  }
  async function addExisting(uids: string[]) {
    const r = await window.api.preview.add(uids);
    setPickerOpen(false);
    await reloadRows();
    onTxChanged();
    show(
      r.ok && r.data!.added < uids.length
        ? `${r.data!.added} added (${uids.length - r.data!.added} already in the list)`
        : `${uids.length} added to the list`,
    );
  }

  // ---------- report ----------
  async function generate() {
    if (!tplId) return show("Choose a template first", { tone: "error" });
    const r = await window.api.reports.prepare(
      tplId,
      rows.map((x) => x.uid),
    );
    if (!r.ok) return show(r.error ?? "Could not generate", { tone: "error" });
    window.api.prefs.set("last_template", String(tplId));
    setReport({
      prepared: r.data!,
      record: true,
      busy: false,
      already: rows.filter((x) => x.report_count > 0).length,
      title: "",
      names: Object.fromEntries(r.data!.files.map((f) => [f.id, f.fileName])),
    });
  }
  async function saveReport() {
    setReport((x) => x && { ...x, busy: true, err: undefined });
    const p = await window.api.reports.prepare(
      Number(tplId),
      rows.map((x) => x.uid),
      report!.title,
    );
    if (!p.ok)
      return setReport((x) => x && { ...x, busy: false, err: p.error });
    const r = await window.api.reports.save(report!.record, report!.names);
    if (r.ok) setReport((x) => x && { ...x, busy: false, saved: r.data!.path });
    else
      setReport(
        (x) =>
          x && {
            ...x,
            busy: false,
            err: r.error === "Cancelled" ? undefined : r.error,
          },
      );
    if (r.ok) onTxChanged(); // "reports" column changed
  }
  const closeReport = () => {
    window.api.reports.discard();
    setReport(null);
  };

  const field = (
    key: string,
    label: string,
    o: { span2?: boolean; right?: boolean; placeholder?: string } = {},
  ) => {
    const isAcc = (ACC as string[]).includes(key);
    return (
      <div className={`field${o.span2 ? " span2" : ""}`} key={key}>
        <label htmlFor={`f-${key}`}>{label}</label>
        <input
          id={`f-${key}`}
          ref={(el) => {
            refs.current[key] = el;
          }}
          value={d[key] ?? ""}
          autoComplete="off"
          spellCheck={false}
          readOnly={isAcc && locked}
          placeholder={o.placeholder}
          className={o.right ? "num" : ""}
          onChange={(e) => setField(key, e.target.value)}
          onKeyDown={(e) => onKey(e, key)}
          onBlur={() => onBlur(key)}
        />
      </div>
    );
  };

  return (
    <>
      <div className="entry">
        {/* ---------- left: the form ---------- */}
        <section className="panel">
          <header>
            <h3>New transaction</h3>
            <span className="grow" style={{ flex: 1 }} />
            <small>Each box searches its own column</small>
          </header>
          <div className="body">
            {locked && (
              <div className="picked">
                <span>✓ Account from master</span>
                <span className="grow" />
                <button className="small" onClick={changeAccount}>
                  Change account
                </button>
              </div>
            )}
            <div className={`fgrid${flash ? " flash" : ""}`}>
              {field("payee", labels.payee + " *", {
                span2: true,
                placeholder: "Type a name to search master…",
              })}
              {field("bank", labels.bank)}
              {field("branch", labels.branch)}
              {field("account_no", labels.account_no)}
              {field("ifsc", labels.ifsc)}
            </div>
            {!locked && d.payee.trim() && (
              <label className="check" style={{ marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={saveToMaster}
                  onChange={(e) => setSaveToMaster(e.target.checked)}
                />
                Save this account to master{" "}
                {saveToMaster ? (
                  ""
                ) : (
                  <small>(one-off: not offered in suggestions)</small>
                )}
              </label>
            )}
            <hr className="sep" />
            <div className="fgrid">
              {field("amount", labels.amount_paise + " (₹) *", { right: true })}
              {field("entry_date", labels.entry_date, {
                placeholder: "dd/mm/yyyy",
              })}
              {field("reference_no", labels.reference_no, { span2: true })}
            </div>
            <button className="moretoggle" onClick={() => setMore((m) => !m)}>
              {more
                ? "− Fewer fields"
                : `+ More fields (${labels.utr}, ${labels.notes}${custom.length ? ", custom" : ""})`}
            </button>
            {more && (
              <div className="fgrid">
                {field("utr", labels.utr)}
                {field("notes", labels.notes)}
                {custom.map((c) => field(c.key, c.label))}
                <div className="span2" style={{ marginBottom: 12 }}>
                  <button className="small" onClick={() => setFieldDlg(true)}>
                    ＋ New field
                  </button>{" "}
                  <small>It will appear as a column in Transactions.</small>
                </div>
              </div>
            )}
            <div className="savebar">
              <button className="primary" onClick={save}>
                Save transaction
              </button>
              <span className="grow" style={{ flex: 1 }} />
              <small>
                <kbd>Enter</kbd> next · on amount <kbd>Enter</kbd> saves ·{" "}
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves
              </small>
            </div>
          </div>
        </section>

        {/* ---------- right: working list + report ---------- */}
        <section className="panel">
          <header>
            <h3>Report list</h3>
            <span className="badge" style={{ margin: 0 }}>
              {rows.length}
            </span>
            <span style={{ flex: 1 }} />
            <button className="small" onClick={() => setPickerOpen(true)}>
              Add existing…
            </button>
          </header>
          <div className="pvwrap">
            {rows.length === 0 ? (
              <div className="pvempty">
                Transactions you save appear here.
                <br />
                Use <b>Add existing…</b> to put earlier transactions in the
                list.
              </div>
            ) : (
              <table className="pv">
                <thead>
                  <tr>
                    <th>S.No</th>
                    <th>{labels.payee}</th>
                    <th className="r">{labels.amount_paise}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.uid}
                      className={r.uid === newUid ? "newrow" : ""}
                    >
                      <td>{i + 1}</td>
                      <td>
                        {r.payee}
                        {r.report_count > 0 && (
                          <span
                            className="tag"
                            title="A report was already generated for this transaction"
                          >
                            ✓ report
                          </span>
                        )}
                        {refCheck.note &&
                          (r.reference_no ? (
                            <div
                              className="muted"
                              style={{ fontSize: "var(--fs-xs)" }}
                            >
                              Ref: {r.reference_no}
                            </div>
                          ) : (
                            <div
                              style={{
                                fontSize: "var(--fs-xs)",
                                color: "var(--danger)",
                              }}
                            >
                              No ref
                            </div>
                          ))}
                      </td>
                      <td className="r">{formatPaise(r.amount_paise)}</td>
                      <td>
                        <button
                          className="ghost small icon"
                          title="Remove from list"
                          onClick={() => removeRow(r)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {refCheck.note && (
            <div
              className="notice"
              style={{ margin: "0 var(--sp-3) var(--sp-2)" }}
            >
              {refCheck.note}
            </div>
          )}
          {refCheck.none && (
            <div
              className="muted"
              style={{
                fontSize: "var(--fs-sm)",
                margin: "0 var(--sp-3) var(--sp-2)",
              }}
            >
              No reference number on these transactions.
            </div>
          )}
          <footer>
            <div className="pvtotal">
              <span className="muted">
                {rows.length} transaction{rows.length === 1 ? "" : "s"} · total
              </span>
              <span className="big">₹{formatPaise(total)}</span>
            </div>
            <div className="pvactions">
              <select
                aria-label="Template"
                value={tplId}
                onChange={(e) =>
                  setTplId(e.target.value ? Number(e.target.value) : "")
                }
              >
                <option value="">Choose template…</option>
                {tplGroups.map(([format, list]) => (
                  <optgroup key={format} label={format}>
                    {list.map((t) => (
                      <option key={t.id} value={t.id} disabled={!t.has_file}>
                        {t.name}
                        {t.has_file ? "" : " (no file)"}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button
                className="primary"
                disabled={!rows.length}
                onClick={generate}
              >
                Generate report
              </button>
              <button
                className="danger"
                disabled={!rows.length}
                onClick={() => setAskClear(true)}
              >
                Clear list
              </button>
            </div>
            {tplSel && (
              <div
                className="muted"
                style={{ fontSize: "var(--fs-sm)", marginTop: 6 }}
                title={tplSel.name}
              >
                Output: {tplSel.format}
              </div>
            )}
          </footer>
        </section>
      </div>

      {sug && (
        <SuggestPanel
          items={sug.items}
          idx={sug.idx}
          field={sug.field}
          text={sug.text}
          anchor={sug.rect}
          onPick={pick}
        />
      )}
      {element}
      <Toast t={toast} onClose={hide} />

      {pickerOpen && (
        <Modal
          wide
          title="Add existing transactions to the list"
          onClose={() => setPickerOpen(false)}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              height: "100%",
            }}
          >
            <TransactionsScreen
              labels={labels}
              refreshKey={0}
              mode="picker"
              onAddToList={addExisting}
            />
          </div>
        </Modal>
      )}
      {askClear && (
        <AskDialog
          title="Clear the list?"
          danger
          confirmLabel="Clear list"
          onResult={async (ok) => {
            setAskClear(false);
            if (ok) {
              await window.api.preview.clear();
              await reloadRows();
              onTxChanged();
            }
          }}
        >
          <p className="muted">
            The transactions stay saved. Only this list is emptied.
          </p>
        </AskDialog>
      )}
      {delRow && (
        <AskDialog
          title="Delete this transaction?"
          danger
          confirmLabel="Delete"
          onResult={(ok) => (ok ? deleteTx() : setDelRow(null))}
        >
          <p>
            <strong>{delRow.payee}</strong> · ₹
            {formatPaise(delRow.amount_paise)}
          </p>
        </AskDialog>
      )}
      {fieldDlg && (
        <NameDialog
          title="New field"
          initial=""
          onClose={() => setFieldDlg(false)}
          onSubmit={async (n) => {
            const r = await window.api.customColumns.add("transaction", n);
            if (!r.ok) return r.error ?? "Failed";
            setCustom(await window.api.customColumns.list("transaction"));
            return null;
          }}
        />
      )}
      {report && (
        <Modal
          title={report.saved ? "Report saved" : "Generate report"}
          onClose={report.busy ? undefined : closeReport}
          actions={
            report.saved ? (
              <>
                <button onClick={closeReport}>Keep list</button>
                <button
                  className="primary"
                  onClick={async () => {
                    await window.api.preview.clear();
                    await reloadRows();
                    onTxChanged();
                    closeReport();
                  }}
                >
                  Clear list
                </button>
              </>
            ) : (
              <>
                <button onClick={closeReport} disabled={report.busy}>
                  Cancel
                </button>
                <button
                  className="primary"
                  autoFocus
                  disabled={report.busy}
                  onClick={saveReport}
                >
                  {report.prepared.files.length > 1
                    ? "Choose folder…"
                    : "Save as…"}
                </button>
              </>
            )
          }
        >
          {report.saved ? (
            <>
              <p className="notice ok">Saved to {report.saved}</p>
              <p className="muted">
                Clear the list to start the next batch, or keep it to generate
                again.
              </p>
            </>
          ) : (
            <>
              <p>
                <strong>{report.prepared.templateName}</strong>
              </p>
              <p>
                {report.prepared.count} transactions · total{" "}
                <b>₹{formatPaise(report.prepared.total_paise)}</b>
                <br />
                <small>{rupeesInWords(report.prepared.total_paise)}</small>
              </p>
              {report.already > 0 && (
                <p className="notice">
                  {report.already} of these already have a saved report.
                </p>
              )}
              <p className="muted">
                Nothing is written until you choose a location. with: Nothing is
                written until you choose a{" "}
                {report.prepared.files.length > 1 ? "folder" : "location"}.
              </p>
              <div className="field" style={{ marginTop: 12 }}>
                <label>Table title (optional, centred above the table)</label>
                <input
                  value={report.title}
                  maxLength={120}
                  placeholder="e.g. Payment details"
                  onChange={(e) =>
                    setReport({ ...report, title: e.target.value })
                  }
                  onKeyDown={(e) =>
                    e.key === "Enter" && !report.busy && saveReport()
                  }
                />
              </div>
              {report.prepared.files.length > 1 && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>File names</label>
                  {report.prepared.files.map((f) => (
                    <input
                      key={f.id}
                      style={{ marginBottom: 6 }}
                      value={report.names[f.id] ?? f.fileName}
                      maxLength={110}
                      aria-label={
                        f.kind === "xlsx" ? "Excel file name" : "Word file name"
                      }
                      onChange={(e) =>
                        setReport({
                          ...report,
                          names: { ...report.names, [f.id]: e.target.value },
                        })
                      }
                    />
                  ))}
                </div>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={report.record}
                  onChange={(e) =>
                    setReport({ ...report, record: e.target.checked })
                  }
                />{" "}
                Save report to database (so we know these transactions have a
                report)
              </label>
              {report.err && <p className="error">{report.err}</p>}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
