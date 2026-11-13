import { useCallback, useEffect, useState } from "react";
import {
  FIELD_KEYS,
  type CustomColumn,
  type Labels,
  type Scope,
  type UnitInfo,
} from "@shared/types";
import { DENSITIES, THEMES } from "@/lib/theme";
import NameDialog from "@/components/NameDialog";
import Modal from "@/components/Modal";
import AskDialog from "@/components/AskDialog";
import Icon from "@/components/Icon";
import { Toast, useToast } from "@/components/Toast";

function Columns({
  scope,
  title,
  onChanged,
}: {
  scope: Scope;
  title: string;
  onChanged: () => void;
}) {
  const [cols, setCols] = useState<CustomColumn[]>([]);
  const [ren, setRen] = useState<CustomColumn | null>(null);
  const load = useCallback(
    () => window.api.customColumns.list(scope, true).then(setCols),
    [scope],
  );
  useEffect(() => {
    load();
  }, [load]);
  const act = async (p: Promise<unknown>) => {
    await p;
    await load();
    onChanged();
  };
  const move = (i: number, dir: -1 | 1) => {
    const live = cols.filter((c) => !c.archived).map((c) => c.key),
      k = cols[i].key,
      a = live.indexOf(k),
      b = a + dir;
    if (a < 0 || b < 0 || b >= live.length) return;
    [live[a], live[b]] = [live[b], live[a]];
    act(window.api.customColumns.reorder(scope, live));
  };
  return (
    <div style={{ marginBottom: 16 }}>
      <strong>{title}</strong>
      {cols.length === 0 && (
        <p className="muted">
          No custom columns. Add one from the{" "}
          <Icon name="add" className="ic-inline" /> in the table header.
        </p>
      )}
      {cols.map((c, i) => (
        <div key={c.key} className={`colrow${c.archived ? " arch" : ""}`}>
          <span className="grow">
            {c.label}
            {c.archived ? " (hidden)" : ""}
          </span>
          {!c.archived && (
            <>
              <button
                className="small icon"
                title="Move up"
                aria-label="Move up"
                onClick={() => move(i, -1)}
              >
                <Icon name="arrowUp" />
              </button>
              <button
                className="small icon"
                title="Move down"
                aria-label="Move down"
                onClick={() => move(i, 1)}
              >
                <Icon name="arrowDown" />
              </button>
              <button className="small" onClick={() => setRen(c)}>
                Rename
              </button>
            </>
          )}
          <button
            className="small"
            onClick={() =>
              act(window.api.customColumns.archive(c.key, !c.archived))
            }
          >
            {c.archived ? "Show again" : "Hide"}
          </button>
        </div>
      ))}
      {ren && (
        <NameDialog
          title="Rename column"
          initial={ren.label}
          onClose={() => setRen(null)}
          onSubmit={async (n) => {
            const r = await window.api.customColumns.rename(ren.key, n);
            if (!r.ok) return r.error ?? "Failed";
            await load();
            onChanged();
            return null;
          }}
        />
      )}
    </div>
  );
}

function NewUnitDialog({
  units,
  onClose,
  onCreate,
}: {
  units: UnitInfo[];
  onClose: () => void;
  onCreate: (name: string, copyFrom: string) => Promise<string | null>;
}) {
  const [name, setName] = useState(`Unit ${units.length + 1}`);
  const [from, setFrom] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    const e = await onCreate(name, from);
    setBusy(false);
    e ? setErr(e) : onClose();
  };
  return (
    <Modal
      title="New unit"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={go}>
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label>Unit name</label>
        <input
          autoFocus
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
      </div>
      <div className="field">
        <label>Copy templates from</label>
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Nothing (start empty)</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display}
            </option>
          ))}
        </select>
      </div>
      {err && <p className="error">{err}</p>}
    </Modal>
  );
}

function DeleteUnitDialog({
  unit,
  recordsName,
  onClose,
  onDone,
}: {
  unit: UnitInfo;
  recordsName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [sum, setSum] = useState<{
    accounts: number;
    transactions: number;
    reports: number;
  } | null>(null);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.api.units
      .summary(unit.id)
      .then((r) => (r.ok ? setSum(r.data!) : setErr(r.error ?? "Failed")));
  }, [unit.id]);
  const go = async () => {
    if (busy || !pw) return;
    setBusy(true);
    setErr("");
    const r = await window.api.units.remove(unit.id, pw);
    setBusy(false);
    onDone(); // refresh the list either way
    if (r.ok) onClose();
    else setErr(r.error ?? "Failed");
  };
  return (
    <AskDialog
      title="Delete unit"
      danger
      confirmLabel="Delete unit"
      confirmDisabled={busy || !pw || !sum}
      onResult={(ok) => (ok ? go() : onClose())}
    >
      <p>
        <strong>{unit.display}</strong>
      </p>
      {sum && (
        <p>
          It holds {sum.accounts} {recordsName} records, {sum.transactions}{" "}
          transactions and {sum.reports} reports.
        </p>
      )}
      <div className="notice" style={{ marginBottom: 8 }}>
        This permanently deletes all data in this unit. It cannot be undone and
        no backup is made automatically.
      </div>
      <div className="field">
        <label>Enter your password to confirm</label>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
      </div>
      {err && <p className="error">{err}</p>}
    </AskDialog>
  );
}

function Units({
  onChanged,
  masterName,
}: {
  onChanged: () => void;
  masterName: string;
}) {
  const [list, setList] = useState<UnitInfo[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dlg, setDlg] = useState<
    | { kind: "new" }
    | { kind: "rename" | "label" | "delete"; unit: UnitInfo }
    | null
  >(null);
  const load = useCallback(async () => {
    const [l, c] = await Promise.all([
      window.api.units.list(),
      window.api.units.current(),
    ]);
    setList(l.units);
    setOpenId(c?.id ?? null);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const done = async () => {
    await load();
    onChanged(); // refresh the header
  };
  return (
    <div className="card">
      <h3>Units</h3>
      <p className="muted">
        Each unit keeps its own data, templates and names. All units use the
        same password. To switch, lock and pick another unit.
      </p>
      {list.map((u) => (
        <div key={u.id} className="colrow">
          <span className="grow">
            {u.display}
            {u.id === openId ? " (open)" : ""}
          </span>
          <button
            className="small"
            onClick={() => setDlg({ kind: "rename", unit: u })}
          >
            Rename
          </button>
          <button
            className="small"
            onClick={() => setDlg({ kind: "label", unit: u })}
          >
            {u.label ? "Edit label" : "Add label"}
          </button>
          <button
            className="small"
            disabled={u.id === openId}
            title={
              u.id === openId
                ? "Open another unit to delete this one"
                : undefined
            }
            onClick={() => setDlg({ kind: "delete", unit: u })}
          >
            Delete
          </button>
        </div>
      ))}
      <button style={{ marginTop: 8 }} onClick={() => setDlg({ kind: "new" })}>
        Add unit…
      </button>
      {dlg?.kind === "new" && (
        <NewUnitDialog
          units={list}
          onClose={() => setDlg(null)}
          onCreate={async (n, from) => {
            const r = await window.api.units.create(n, "", from || undefined);
            await load(); // the unit may exist even if copying failed
            return r.ok ? null : (r.error ?? "Failed");
          }}
        />
      )}
      {dlg?.kind === "rename" && (
        <NameDialog
          title="Rename unit"
          initial={dlg.unit.name}
          onClose={() => setDlg(null)}
          onSubmit={async (n) => {
            const r = await window.api.units.rename(dlg.unit.id, n);
            if (!r.ok) return r.error ?? "Failed";
            await done();
            return null;
          }}
        />
      )}
      {dlg?.kind === "delete" && (
        <DeleteUnitDialog
          unit={dlg.unit}
          recordsName={masterName}
          onClose={() => setDlg(null)}
          onDone={load}
        />
      )}
      {dlg?.kind === "label" && (
        <NameDialog
          title="Unit label (leave empty for none)"
          initial={dlg.unit.label}
          onClose={() => setDlg(null)}
          onSubmit={async (l) => {
            const r = await window.api.units.setLabel(dlg.unit.id, l);
            if (!r.ok) return r.error ?? "Failed";
            await done();
            return null;
          }}
        />
      )}
    </div>
  );
}

export default function SettingsScreen({
  labels,
  masterName,
  theme,
  density,
  onLabels,
  onMasterName,
  onTheme,
  onColumnsChanged,
  onUnitChanged,
}: {
  labels: Labels;
  masterName: string;
  theme: string;
  density: string;
  onLabels: () => void;
  onMasterName: (n: string) => void;
  onTheme: (theme: string, density: string) => void;
  onColumnsChanged: () => void;
  onUnitChanged: () => void;
}) {
  const [mname, setMname] = useState(masterName);
  const [backup, setBackup] = useState("");
  const { toast, show, hide } = useToast();

  async function saveLabel(
    k: (typeof FIELD_KEYS)[number],
    v: string,
    el: HTMLInputElement,
  ) {
    if (v.trim() === labels[k]) return;
    const r = await window.api.labels.set(k, v);
    if (!r.ok) {
      show(r.error ?? "Failed", { tone: "error" });
      el.value = labels[k];
    } else {
      onLabels();
      show("Name saved");
    }
  }
  async function doBackup() {
    const r = await window.api.backup.create();
    if (r.ok) setBackup(`Backup saved: ${r.data!.path}`);
    else if (r.error !== "Cancelled")
      show(r.error ?? "Backup failed", { tone: "error" });
  }

  return (
    <>
      <div className="toolbar">
        <h2>Settings</h2>
      </div>
      <div className="settings">
        <div className="card">
          <h3>Appearance</h3>
          <div className="row" style={{ maxWidth: 520 }}>
            <div className="field">
              <label>Theme</label>
              <select
                value={theme}
                onChange={(e) => onTheme(e.target.value, density)}
              >
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Row density</label>
              <select
                value={density}
                onChange={(e) => onTheme(theme, e.target.value)}
              >
                {DENSITIES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="card">
          <h3>Names</h3>
          <div className="field" style={{ maxWidth: 320 }}>
            <label>
              Name of the master tab (you can also double-click the tab)
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={mname}
                maxLength={40}
                onChange={(e) => setMname(e.target.value)}
              />
              <button
                onClick={() => mname.trim() && onMasterName(mname.trim())}
              >
                Save
              </button>
            </div>
          </div>
          <p className="muted">
            Column names. Renaming never breaks Word placeholders.
          </p>
          <div className="labelgrid">
            {FIELD_KEYS.map((k) => (
              <div className="field" key={k}>
                <label>{k.replace(/_paise$/, "").replace(/_/g, " ")}</label>
                <input
                  key={labels[k]}
                  defaultValue={labels[k]}
                  maxLength={40}
                  onBlur={(e) => saveLabel(k, e.target.value, e.currentTarget)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3>Custom columns</h3>
          <Columns
            scope="account"
            title={`${masterName} columns`}
            onChanged={onColumnsChanged}
          />
          <Columns
            scope="transaction"
            title="Transaction columns"
            onChanged={onColumnsChanged}
          />
        </div>

        <Units onChanged={onUnitChanged} masterName={masterName} />

        <div className="card">
          <h3>Backup</h3>
          <p className="muted">
            Saves an encrypted copy of the open unit's data (and the key file)
            to a place you choose, e.g. a pen drive. Other units are not
            included; open each one and back it up separately. Your recovery key
            opens the backup too.
          </p>
          <button className="primary" onClick={doBackup}>
            Back up now…
          </button>
          {backup && (
            <p className="notice ok" style={{ marginTop: 8 }}>
              {backup}
            </p>
          )}
        </div>
      </div>
      <Toast t={toast} onClose={hide} />
    </>
  );
}
