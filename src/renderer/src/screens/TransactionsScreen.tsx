import { useEffect, useMemo, useState } from "react";
import {
  TX_COLUMNS,
  TX_EDITABLE,
  type CustomColumn,
  type Labels,
  type TxChanges,
  type TxRow,
  type TxUndoInfo,
} from "@shared/types";
import { canDelete } from "@shared/rules";
import { fmtDate, formatPaise, parseAmount, parseDate } from "@shared/format";
import DataGrid, { type GridCol } from "@/components/DataGrid";
import NameDialog from "@/components/NameDialog";
import AskDialog from "@/components/AskDialog";
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
  refreshKey,
  mode = "tab",
  onAddToList,
  onChanged,
  onMasterChanged,
}: {
  labels: Labels;
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
  const [importOpen, setImportOpen] = useState(false);
  const [undo, setUndo] = useState<TxUndoInfo | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const { toast, show, hide } = useToast();
  const { withConfirm, element } = useConfirmFlow();
  const g = useGridData((q) => window.api.transactions.list(q), {}, refreshKey);

  const loadCustom = () =>
    window.api.customColumns.list("transaction").then(setCustom);

  useEffect(() => {
    loadCustom();
  }, [refreshKey]);

  const loadUndo = () => {
    if (!picker) window.api.txImport.undoInfo().then(setUndo);
  };

  useEffect(() => {
    loadUndo();
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  function clickUndo() {
    if (!undo) return;
    if (!undo.canUndo)
      return show(
        `${undo.inReports} imported transactions are already in saved reports, so this import can no longer be undone`,
        { tone: "error" },
      );
    setUndoOpen(true);
  }

  async function doUndo() {
    setUndoOpen(false);
    const r = await window.api.txImport.undoLast();
    if (!r.ok) return show(r.error ?? "Could not undo", { tone: "error" });
    const d = r.data!;
    show(
      `Import undone: ${d.transactions.toLocaleString("en-IN")} transactions removed` +
        (d.revertSkipped
          ? ` · ${d.revertSkipped} master edits kept because you changed them since`
          : ""),
    );
    onChanged?.();
    onMasterChanged?.();
    loadUndo();
  }

  const addSelected = async () => {
    await onAddToList([...selected]);
    setSelected(new Set());
  };

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
          <button onClick={() => setColsOpen((o) => !o)}>Columns ▾</button>
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
          <button onClick={() => setImportOpen(true)}>Import Excel…</button>
        )}
        {!picker && undo && (
          <button
            className="ghost"
            onClick={clickUndo}
            title={`Imported ${new Date(undo.created_at).toLocaleString("en-IN")} from ${undo.file_name}`}
          >
            Undo last import
          </button>
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
        actionsW={picker ? 0 : 48}
        actions={
          picker
            ? undefined
            : (r) => (
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
                  🗑
                </button>
              )
        }
        headerExtra={
          picker ? undefined : (
            <button
              className="ghost icon small"
              title="Add custom column"
              onClick={() => setNameDlg(true)}
            >
              ＋
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
          Editable here:{" "}
          {[
            labels.reference_no,
            labels.entry_date,
            labels.amount_paise,
            labels.utr,
            labels.notes,
          ].join(", ")}{" "}
          and custom columns · {labels.payee}, bank, branch, account no and IFSC
          are edited in master · filters: <code>&gt;5000</code>,{" "}
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
      {importOpen && (
        <TxImportDialog
          labels={labels}
          onClose={(changed) => {
            setImportOpen(false);
            if (changed) {
              onChanged?.();
              onMasterChanged?.();
              loadUndo();
            }
          }}
        />
      )}
      {undoOpen && undo && (
        <AskDialog
          title="Undo the last import?"
          danger
          confirmLabel="Undo import"
          onResult={(ok) => (ok ? doUndo() : setUndoOpen(false))}
        >
          <p>
            <strong>{undo.file_name}</strong> · imported{" "}
            {new Date(undo.created_at).toLocaleString("en-IN")}
          </p>
          <p>
            This deletes <b>{undo.transactions.toLocaleString("en-IN")}</b>{" "}
            imported transactions
            {undo.newAccounts
              ? ` and the ${undo.newAccounts.toLocaleString("en-IN")} accounts it created`
              : ""}
            , and restores any master details the import changed.
          </p>
          {undo.edited > 0 && (
            <div className="notice">
              {undo.edited} of these transactions were edited after the import
              (for example a UTR was added). Those edits will be lost too.
            </div>
          )}
        </AskDialog>
      )}
      {element}
      <Toast t={toast} onClose={hide} />
    </>
  );
}
