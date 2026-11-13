import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACCOUNT_KEYS,
  type Account,
  type AccountInput,
  type CustomColumn,
  type Labels,
} from "@shared/types";
import DataGrid, { type GridCol } from "@/components/DataGrid";
import NameDialog from "@/components/NameDialog";
import Icon from "@/components/Icon";
import UndoImportButton from "@/components/UndoImportButton";
import CorrectDialog from "@/components/CorrectDialog";
import HistoryDialog from "@/components/HistoryDialog";
import ImportPanel from "./ImportPanel";
import { Toast, useToast } from "@/components/Toast";
import { useConfirmFlow } from "@/lib/useConfirmFlow";
import { useGridData } from "@/lib/useGridData";

const W: Record<string, number> = {
  payee: 230,
  account_no: 170,
  bank: 180,
  branch: 160,
  ifsc: 120,
  remarks: 240,
};

const blank = (): Record<string, string> => ({
  payee: "",
  account_no: "",
  bank: "",
  branch: "",
  ifsc: "",
  remarks: "",
});

const LOCKED = ACCOUNT_KEYS.filter((k) => k !== "remarks");

export default function MasterScreen({
  labels,
  title,
  refreshKey,
  onChanged,
  onTxChanged,
  undoKey,
}: {
  labels: Labels;
  title: string;
  refreshKey: number;
  onChanged: () => void;
  onTxChanged: () => void;
  undoKey: number;
}) {
  const [mode, setMode] = useState<"grid" | "import">("grid");
  const [oneOff, setOneOff] = useState(false);
  const [custom, setCustom] = useState<CustomColumn[]>([]);
  const [form, setForm] = useState(blank());
  const [nameDlg, setNameDlg] = useState(false);
  const [fixRow, setFixRow] = useState<Account | null>(null);
  const [histRow, setHistRow] = useState<Account | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const { toast, show, hide } = useToast();
  const { withConfirm, element } = useConfirmFlow();
  const g = useGridData(
    (q) => window.api.accounts.list(q),
    { oneOff },
    refreshKey,
  );

  const loadCustom = () =>
    window.api.customColumns.list("account").then(setCustom);
  useEffect(() => {
    loadCustom();
  }, [refreshKey]);

  const cols: GridCol[] = useMemo(
    () => [
      ...ACCOUNT_KEYS.map((k) => ({
        key: k,
        label: labels[k],
        w: W[k],
        editable: k === "remarks",
      })),
      ...custom.map((c) => ({
        key: c.key,
        label: c.label,
        w: 150,
        editable: true,
      })),
    ],
    [labels, custom],
  );

  const text = (a: Account, c: GridCol) =>
    c.key.startsWith("x_")
      ? (JSON.parse(a.extra || "{}")[c.key] ?? "")
      : String((a as any)[c.key] ?? "");
  const showExisting = {
    label: "Show that record",
    run: (a: Account) => {
      g.clearFilters();
      g.setFilter("account_no", a.account_no);
    },
  };

  async function commit(
    a: Account,
    c: GridCol,
    value: string,
  ): Promise<string | null> {
    const changes: Partial<AccountInput> = c.key.startsWith("x_")
      ? { extra: { [c.key]: value } }
      : { [c.key]: value };
    const r = await withConfirm(
      (conf) => window.api.accounts.update(a.id, changes, conf),
      {
        title: "Check this change",
        payee: a.payee,
        existingAction: showExisting,
      },
    );
    if (!r) return null;
    if (!r.ok) {
      show(r.error ?? "Could not save", { tone: "error" });
      return null;
    }
    g.patch((x) => x.id === a.id, r.data!);
    onChanged(); // transactions and the entry list read from master, so they refresh
    return text(r.data!, c);
  }

  async function doCorrect(
    a: Account,
    changes: Partial<AccountInput>,
    auth: { password?: string; reason?: string },
  ): Promise<boolean | string> {
    const r = await withConfirm(
      (conf) => window.api.accounts.correct(a.id, changes, conf, auth),
      {
        title: "Check this change",
        payee: a.payee,
        existingAction: showExisting,
      },
    );
    if (!r) return false; // cancelled at a confirmation: dialog stays open
    if (!r.ok) return r.error ?? "Could not save";
    g.patch((x) => x.id === a.id, r.data!);
    onChanged(); // transactions and the entry list read from accounts, so they refresh
    show("Account updated");
    return true;
  }

  async function add() {
    if (!form.payee.trim()) {
      show("Beneficiary name is required", { tone: "error" });
      first.current?.focus();
      return;
    }
    const r = await withConfirm(
      (conf) =>
        window.api.accounts.create(form as unknown as AccountInput, conf),
      {
        title: "Possible duplicate",
        payee: form.payee,
        existingAction: showExisting,
      },
    );
    if (!r) return;
    if (!r.ok) {
      show(r.error ?? "Could not add", { tone: "error" });
      return;
    }
    setForm(blank());
    show(`Added ${r.data!.payee}`);
    g.reload();
    onChanged();
    first.current?.focus();
  }
  const addWithAction = () => add();

  if (mode === "import")
    return (
      <ImportPanel
        labels={labels}
        masterName={title}
        onClose={(changed) => {
          setMode("grid");
          if (changed) {
            g.reload();
            onChanged();
          }
        }}
      />
    );

  return (
    <>
      <div className="toolbar">
        <h2>{title}</h2>
        <span className="stat">
          <b>{g.total.toLocaleString("en-IN")}</b>{" "}
          {oneOff ? "one-off accounts" : "accounts"}
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
        <label
          className="check"
          title="Accounts typed on the Entry screen with “Save to master” switched off"
        >
          <input
            type="checkbox"
            checked={oneOff}
            onChange={(e) => setOneOff(e.target.checked)}
          />{" "}
          Show one-off accounts
        </label>
        <UndoImportButton
          refreshKey={undoKey}
          accountsName={title}
          onUndone={() => {
            onChanged();
            onTxChanged();
          }}
        />
        <button className="primary" onClick={() => setMode("import")}>
          Import / Paste…
        </button>
      </div>

      {!oneOff && (
        <div
          className="addbar"
          onKeyDown={(e) => e.key === "Enter" && addWithAction()}
        >
          {ACCOUNT_KEYS.map((k, i) => (
            <div className="field" key={k}>
              <label>
                {labels[k]}
                {k === "payee" ? " *" : ""}
              </label>
              <input
                ref={i === 0 ? first : undefined}
                value={form[k]}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    [k]:
                      k === "ifsc"
                        ? e.target.value.toUpperCase()
                        : e.target.value,
                  }))
                }
              />
            </div>
          ))}
          <button className="primary" onClick={addWithAction}>
            Add
          </button>
        </div>
      )}

      <DataGrid<Account>
        cols={cols}
        rows={g.rows}
        total={g.total}
        rowKey={(a) => a.id}
        getText={text}
        onCommit={commit}
        sort={g.sort}
        onSort={g.toggleSort}
        filters={g.filters}
        onFilter={g.setFilter}
        onNeedMore={g.loadMore}
        actionsW={96}
        actions={(a) => (
          <>
            <button
              className="ghost"
              title="History"
              onClick={() => setHistRow(a)}
            >
              <Icon name="history" />
            </button>
            <button
              className="ghost"
              title="Edit beneficiary, account no, bank, branch or IFSC"
              onClick={() => setFixRow(a)}
            >
              <Icon name="edit" />
            </button>
          </>
        )}
        headerExtra={
          <button
            className="ghost icon small"
            title="Add custom column"
            aria-label="Add custom column"
            onClick={() => setNameDlg(true)}
          >
            <Icon name="add" />
          </button>
        }
        empty={
          g.loading
            ? "Loading…"
            : g.hasFilters
              ? "No accounts match these filters"
              : "No accounts yet. Use Import / Paste, or the Add row above."
        }
      />
      <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
        Double-click or <kbd>F2</kbd> to edit {labels.remarks} and custom
        columns · <kbd>Enter</kbd> saves · <kbd>Esc</kbd> cancels · use{" "}
        <Icon name="edit" className="ic-inline" /> to edit{" "}
        {LOCKED.map((k) => labels[k]).join(", ")} · changes here update every
        transaction that uses the account.
      </div>

      {nameDlg && (
        <NameDialog
          title="New column"
          initial=""
          onClose={() => setNameDlg(false)}
          onSubmit={async (n) => {
            const r = await window.api.customColumns.add("account", n);
            if (!r.ok) return r.error ?? "Failed";
            await loadCustom();
            return null;
          }}
        />
      )}

      {histRow && (
        <HistoryDialog
          kind="accounts"
          id={histRow.id}
          createdAt={histRow.created_at}
          summary={
            <>
              <strong>{histRow.payee}</strong> · {histRow.account_no}
            </>
          }
          labels={labels}
          onClose={() => setHistRow(null)}
        />
      )}

      {fixRow && (
        <CorrectDialog
          title="Edit this account"
          noun="account"
          subject={
            <>
              <strong>{fixRow.payee}</strong>
              <span className="muted">
                {" "}
                · used by {fixRow.use_count} transaction
                {fixRow.use_count === 1 ? "" : "s"}, which will all show the new
                details
              </span>
            </>
          }
          createdAt={fixRow.created_at}
          fields={LOCKED.map((k) => ({
            key: k,
            label: labels[k],
            value: fixRow[k],
            text: fixRow[k],
            was: fixRow[k] || "blank",
            maxLength: k === "account_no" ? 60 : undefined,
            parse:
              k === "ifsc"
                ? (t: string) => ({ value: t.trim().toUpperCase() })
                : undefined,
          }))}
          onClose={() => setFixRow(null)}
          onSubmit={(ch, auth) =>
            doCorrect(fixRow, ch as Partial<AccountInput>, auth)
          }
        />
      )}

      {element}
      <Toast t={toast} onClose={hide} />
    </>
  );
}
