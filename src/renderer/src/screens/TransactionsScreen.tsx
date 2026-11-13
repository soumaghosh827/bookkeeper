import { useEffect, useMemo, useState } from "react";
import {
  TX_COLUMNS,
  TX_EDITABLE,
  type CustomColumn,
  type Labels,
  type TxChanges,
  type TxRow,
} from "@shared/types";
import { canDelete } from "@shared/rules";
import { fmtDate, formatPaise, parseAmount, parseDate } from "@shared/format";
import DataGrid, { type GridCol } from "@/components/DataGrid";
import NameDialog from "@/components/NameDialog";
import AskDialog from "@/components/AskDialog";
import CorrectDialog from "@/components/CorrectDialog";
import HistoryDialog from "@/components/HistoryDialog";
import Icon from "@/components/Icon";
import UndoImportButton from "@/components/UndoImportButton";
import { Toast, useToast } from "@/components/Toast";
import { useConfirmFlow } from "@/lib/useConfirmFlow";
import { useGridData } from "@/lib/useGridData";
import TxImportDialog from "./TxImportDialog";

const W: Record<string, number> = {
  reference_no: 140,
  entry_date: 118,
  payee: 220,
  bank: 160,
  branch: 140,
  account_no: 150,
  ifsc: 115,
  amount_paise: 130,
  utr: 160,
  notes: 210,
  report_count: 90,
};
const HINT: Record<string, string> = {
  entry_date: "yyyy-mm or >dd/mm/yyyy",
  amount_paise: ">5000 or 100..500",
  report_count: "0 = none yet",
};
const ALWAYS = ["payee", "amount_paise"];

export default function TransactionsScreen({
  labels,
  masterName,
  refreshKey,
  mode = "tab",
  onAddToList,
  onChanged,
  onMasterChanged,
}: {
  labels: Labels;
  masterName?: string;
  refreshKey: number;
  mode?: "tab" | "picker";
  onAddToList: (uids: string[]) => void | Promise<void>;
  onChanged?: () => void;
  onMasterChanged?: () => void;
}) {
  const picker = mode === "picker";
  const [custom, setCustom] = useState<CustomColumn[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [colsOpen, setColsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [nameDlg, setNameDlg] = useState(false);
  const [delRow, setDelRow] = useState<TxRow | null>(null);
  const [fixRow, setFixRow] = useState<TxRow | null>(null);
  const [histRow, setHistRow] = useState<TxRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const { toast, show, hide } = useToast();
  const { withConfirm, element } = useConfirmFlow();
  const g = useGridData((q) => window.api.transactions.list(q), {}, refreshKey);

  const loadCustom = () =>
    window.api.customColumns.list("transaction").then(setCustom);

  useEffect(() => {
    loadCustom();
  }, [refreshKey]);

  useEffect(() => {
    window.api.prefs.get("tx_columns").then((s) => {
      try {
        const a = s ? JSON.parse(s) : [];
        if (Array.isArray(a)) setHidden(a.map(String));
      } catch {
        /* ignore */
      }
    });
  }, []);

  useEffect(() => {
    setSelected(new Set());
  }, [g.q, g.filters, g.sort]); // a selection never survives a different view

  const all: GridCol[] = useMemo(
    () => [
      ...TX_COLUMNS.map((k) => ({
        key: k,
        label: labels[k],
        w: W[k],
        align: k === "amount_paise" ? ("right" as const) : undefined,
        editable: !picker && TX_EDITABLE.includes(k),
        hint: HINT[k],
      })),
      ...custom.map((c) => ({
        key: c.key,
        label: c.label,
        w: 150,
        editable: !picker,
      })),
      {
        key: "report_count",
        label: "Reports",
        w: W.report_count,
        align: "right" as const,
        hint: HINT.report_count,
      },
    ],
    [labels, custom, picker],
  );
  const cols = all.filter(
    (c) => ALWAYS.includes(c.key) || !hidden.includes(c.key),
  );

  function saveHidden(next: string[]) {
    setHidden(next);
    window.api.prefs.set("tx_columns", JSON.stringify(next));
  }
  const toggleCol = (k: string) =>
    saveHidden(
      hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k],
    );

  const text = (r: TxRow, c: GridCol) => {
    if (c.key.startsWith("x_")) return JSON.parse(r.extra || "{}")[c.key] ?? "";
    if (c.key === "amount_paise") return formatPaise(r.amount_paise);
    if (c.key === "entry_date") return fmtDate(r.entry_date);
    if (c.key === "report_count")
      return r.report_count ? String(r.report_count) : "";
    return String((r as any)[c.key] ?? "");
  };

  async function commit(
    r: TxRow,
    c: GridCol,
    value: string,
  ): Promise<string | null> {
    let changes: TxChanges;
    let amountPaise = r.amount_paise;
    if (c.key.startsWith("x_")) changes = { extra: { [c.key]: value } };
    else if (c.key === "amount_paise") {
      const a = parseAmount(value);
      if (!a.ok) {
        show("Amount is not valid", { tone: "error" });
        return null;
      }
      amountPaise = a.paise ?? 0;
      changes = { amount_paise: amountPaise };
    } else if (c.key === "entry_date") {
      const d = parseDate(value);
      if (!d) {
        show("Date is not valid (use dd/mm/yyyy)", { tone: "error" });
        return null;
      }
      changes = { entry_date: d };
    } else changes = { [c.key]: value } as TxChanges;
    const res = await withConfirm(
      (conf) => window.api.transactions.update(r.uid, changes, conf),
      { payee: r.payee, amountPaise },
    );
    if (!res) return null;
    if (!res.ok) {
      show(res.error ?? "Could not save", { tone: "error" });
      return null;
    }
    g.patch((x) => x.uid === r.uid, res.data!);
    onChanged?.();
    return text(res.data!, c);
  }

  async function doCorrect(
    r: TxRow,
    changes: Pick<TxChanges, "amount_paise" | "entry_date" | "reference_no">,
    auth: { password?: string; reason?: string },
  ): Promise<boolean | string> {
    const res = await withConfirm(
      (conf) => window.api.transactions.correct(r.uid, changes, conf, auth),
      { payee: r.payee, amountPaise: changes.amount_paise ?? r.amount_paise },
    );
    if (!res) return false; // cancelled at a confirmation: dialog stays open
    if (!res.ok) return res.error ?? "Could not save";
    g.patch((x) => x.uid === r.uid, res.data!);
    onChanged?.();
    show("Transaction corrected");
    return true;
  }

  async function doDelete() {
    const r = delRow!;
    setDelRow(null);
    const res = await window.api.transactions.remove(r.uid);
    if (!res.ok)
      return show(res.error ?? "Could not delete", { tone: "error" });
    g.drop((x) => x.uid === r.uid);
    onChanged?.();
    show("Transaction deleted");
  }

  async function exportXlsx() {
    const r = await window.api.transactions.exportXlsx(g.query());
    if (r.ok) show(`Exported ${r.data!.rows.toLocaleString("en-IN")} rows`);
    else if (r.error !== "Cancelled")
      show(r.error ?? "Export failed", { tone: "error" });
  }

  const addSelected = async () => {
    await onAddToList([...selected]);
    setSelected(new Set());
  };

  if (importOpen)
    return (
      <TxImportDialog
        labels={labels}
        masterName={masterName}
        onClose={(changed) => {
          setImportOpen(false);
          if (changed) {
            onChanged?.();
            onMasterChanged?.();
          }
        }}
      />
    );

  return (
    <>
      <div className="toolbar">
        {!picker && <h2>Transactions</h2>}
        <span className="stat">
          <b>{g.total.toLocaleString("en-IN")}</b> transactions · total{" "}
          <b>₹{formatPaise(g.sumPaise)}</b>
          {g.hasFilters ? " (filtered)" : ""}
        </span>
        <input
          type="search"
          className="search"
          placeholder="Search all columns…"
          value={g.q}
          onChange={(e) => g.setQ(e.target.value)}
        />
        {g.hasFilters && (
          <button className="ghost small" onClick={g.clearFilters}>
            Clear filters
          </button>
        )}
        <span className="grow" />
        <button
          className="primary"
          disabled={selected.size === 0}
          onClick={addSelected}
        >
          {picker ? "Add to list" : "Add to report list"}
          {selected.size ? ` (${selected.size})` : ""}
        </button>
        <div style={{ position: "relative" }}>
          <button onClick={() => setColsOpen((o) => !o)}>
            Columns <Icon name="down" className="ic-inline" />
          </button>
          {colsOpen && (
            <>
              <div className="popback" onClick={() => setColsOpen(false)} />
              <div className="popover">
                {all
                  .filter((c) => !ALWAYS.includes(c.key))
                  .map((c) => (
                    <label key={c.key}>
                      <input
                        type="checkbox"
                        checked={!hidden.includes(c.key)}
                        onChange={() => toggleCol(c.key)}
                      />
                      {c.label}
                    </label>
                  ))}
                <button className="small" onClick={() => saveHidden([])}>
                  Show all
                </button>
              </div>
            </>
          )}
        </div>

        {!picker && (
          <button onClick={() => setImportOpen(true)}>Import Excel</button>
        )}
        {!picker && (
          <UndoImportButton
            refreshKey={refreshKey}
            accountsName={masterName ?? "Accounts"}
            onUndone={() => {
              onChanged?.();
              onMasterChanged?.();
            }}
          />
        )}

        {!picker && (
          <button
            onClick={exportXlsx}
            title="Exports the rows matching the current filters"
          >
            Export Excel…
          </button>
        )}
      </div>

      <DataGrid<TxRow>
        cols={cols}
        rows={g.rows}
        total={g.total}
        rowKey={(r) => r.uid}
        getText={text}
        onCommit={picker ? undefined : commit}
        sort={g.sort}
        onSort={g.toggleSort}
        filters={g.filters}
        onFilter={g.setFilter}
        onNeedMore={g.loadMore}
        selected={selected}
        onSelect={setSelected}
        actionsW={picker ? 0 : 96}
        actions={
          picker
            ? undefined
            : (r) => (
                <>
                  <button
                    className="ghost"
                    title="History"
                    onClick={() => setHistRow(r)}
                  >
                    <Icon name="history" />
                  </button>
                  <button
                    className="ghost"
                    title="Correct amount, date or reference"
                    onClick={() => setFixRow(r)}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className="ghost danger"
                    disabled={!canDelete(r.created_at)}
                    title={
                      canDelete(r.created_at)
                        ? "Delete"
                        : "Locked: older than 2 days"
                    }
                    onClick={() => setDelRow(r)}
                  >
                    <Icon name="delete" />
                  </button>
                </>
              )
        }
        headerExtra={
          picker ? undefined : (
            <button
              className="ghost icon small"
              title="Add custom column"
              onClick={() => setNameDlg(true)}
            >
              <Icon name="add" />
            </button>
          )
        }
        empty={
          g.loading
            ? "Loading…"
            : g.hasFilters
              ? "No transactions match these filters"
              : "No transactions yet. Add some on the Entry screen."
        }
      />
      {!picker && (
        <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
          Editable here: {[labels.utr, labels.notes].join(", ")} and custom
          columns · use <Icon name="edit" className="ic-inline" /> to correct{" "}
          {labels.amount_paise}, {labels.entry_date} or {labels.reference_no} ·{" "}
          {labels.payee}, bank, branch, account no and IFSC are edited in{" "}
          {masterName ?? "the accounts tab"} · filters: <code>&gt;5000</code>,{" "}
          <code>100..500</code>, <code>&gt;=01/04/2026</code>
        </div>
      )}

      {nameDlg && (
        <NameDialog
          title="New column"
          initial=""
          onClose={() => setNameDlg(false)}
          onSubmit={async (n) => {
            const r = await window.api.customColumns.add("transaction", n);
            if (!r.ok) return r.error ?? "Failed";
            await loadCustom();
            return null;
          }}
        />
      )}

      {histRow && (
        <HistoryDialog
          kind="transactions"
          id={histRow.uid}
          createdAt={histRow.created_at}
          summary={
            <>
              <strong>{histRow.payee}</strong> · ₹
              {formatPaise(histRow.amount_paise)} ·{" "}
              {fmtDate(histRow.entry_date)}
            </>
          }
          labels={labels}
          onClose={() => setHistRow(null)}
        />
      )}

      {fixRow && (
        <CorrectDialog
          title="Correct this transaction"
          noun="transaction"
          subject={<strong>{fixRow.payee}</strong>}
          createdAt={fixRow.created_at}
          fields={[
            {
              key: "amount_paise",
              label: labels.amount_paise,
              value: fixRow.amount_paise,
              text: formatPaise(fixRow.amount_paise),
              was: `₹${formatPaise(fixRow.amount_paise)}`,
              parse: (t) => {
                const a = parseAmount(t);
                return a.ok
                  ? { value: a.paise ?? 0 }
                  : { error: `${labels.amount_paise} is not valid` };
              },
            },
            {
              key: "entry_date",
              label: labels.entry_date,
              value: fixRow.entry_date,
              text: fmtDate(fixRow.entry_date),
              was: fmtDate(fixRow.entry_date),
              parse: (t) => {
                const d = parseDate(t);
                return d
                  ? { value: d }
                  : {
                      error: `${labels.entry_date} is not valid (use dd/mm/yyyy)`,
                    };
              },
            },
            {
              key: "reference_no",
              label: labels.reference_no,
              value: fixRow.reference_no,
              text: fixRow.reference_no,
              was: fixRow.reference_no || "blank",
              maxLength: 100,
            },
          ]}
          onClose={() => setFixRow(null)}
          onSubmit={(ch, auth) =>
            doCorrect(fixRow, ch as Parameters<typeof doCorrect>[1], auth)
          }
        />
      )}

      {delRow && (
        <AskDialog
          title="Delete this transaction?"
          danger
          confirmLabel="Delete"
          onResult={(ok) => (ok ? doDelete() : setDelRow(null))}
        >
          <p>
            <strong>{delRow.payee}</strong> · ₹
            {formatPaise(delRow.amount_paise)} · {fmtDate(delRow.entry_date)}
          </p>
          <p className="muted">
            Deleting is only possible within 2 days of creation. It is removed
            from the report list too.
          </p>
        </AskDialog>
      )}

      {element}
      <Toast t={toast} onClose={hide} />
    </>
  );
}
