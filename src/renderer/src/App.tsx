import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_LABELS,
  type AppState,
  type Labels,
  type UnitInfo,
} from "@shared/types";
import AuthScreen from "./screens/AuthScreen";
import EntryScreen from "./screens/EntryScreen";
import MasterScreen from "./screens/MasterScreen";
import TransactionsScreen from "./screens/TransactionsScreen";
import TemplatesScreen from "./screens/TemplatesScreen";
import SettingsScreen from "./screens/SettingsScreen";
import NameDialog from "./components/NameDialog";
import { Toast, useToast } from "./components/Toast";
import { applyTheme } from "./lib/theme";
import Icon, { type IconName } from "./components/Icon";
import AskDialog from "./components/AskDialog";

type Tab = "entry" | "master" | "transactions" | "templates" | "settings";

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>("entry");
  const [labels, setLabels] = useState<Labels>(DEFAULT_LABELS);
  const [masterName, setMasterName] = useState("Master");
  const [theme, setTheme] = useState("light");
  const [density, setDensity] = useState("comfortable");
  const [count, setCount] = useState(0);
  const [unit, setUnit] = useState<UnitInfo | null>(null); // the open unit
  const [masterV, setMasterV] = useState(0); // bumps when master data changes -> other screens re-read
  const [txV, setTxV] = useState(0); // bumps when transactions / the report list change
  const [renameMaster, setRenameMaster] = useState(false);
  const [tplDirty, setTplDirty] = useState(false); // Templates screen has unsaved edits
  const [pendingTab, setPendingTab] = useState<Tab | null>(null); // tab waiting for "discard?" answer
  const { toast, show, hide } = useToast();

  const bumpMaster = useCallback(() => setMasterV((v) => v + 1), []);
  const bumpTx = useCallback(() => setTxV((v) => v + 1), []);

  const goTab = useCallback(
    (t: Tab) => {
      if (tab === "templates" && t !== "templates" && tplDirty)
        setPendingTab(t);
      else setTab(t);
    },
    [tab, tplDirty],
  );

  useEffect(() => {
    window.api.vault.state().then(setState);
  }, []);

  const loadSettings = useCallback(async () => {
    setLabels(await window.api.labels.get());
    const [mn, th, de] = await Promise.all([
      window.api.prefs.get("master_name"),
      window.api.prefs.get("theme"),
      window.api.prefs.get("density"),
    ]);
    setMasterName(mn || "Master"); // per unit: a unit without a custom name shows the default
    setTheme(th ?? "light");
    setDensity(de ?? "comfortable");
    applyTheme(th, de);
  }, []);
  const loadUnit = useCallback(async () => {
    setUnit(await window.api.units.current());
  }, []);
  useEffect(() => {
    if (state === "unlocked") {
      loadSettings();
      loadUnit();
    }
  }, [state, loadSettings, loadUnit]);

  // Ctrl+1..5 switches tabs
  useEffect(() => {
    if (state !== "unlocked") return;
    const tabs: Tab[] = [
      "entry",
      "master",
      "transactions",
      "templates",
      "settings",
    ];
    const f = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        /^[1-5]$/.test(e.key)
      ) {
        e.preventDefault();
        goTab(tabs[+e.key - 1]);
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [state, goTab]);

  const changeTheme = (t: string, d: string) => {
    setTheme(t);
    setDensity(d);
    applyTheme(t, d);
    window.api.prefs.set("theme", t);
    window.api.prefs.set("density", d);
  };
  const changeMasterName = async (n: string) => {
    const r = await window.api.prefs.set("master_name", n);
    if (r.ok) setMasterName(n);
  };
  const lock = async () => {
    await window.api.vault.lock();
    setState("locked");
    setTab("entry");
    setCount(0);
    setUnit(null);
    setTplDirty(false);
    setPendingTab(null);
  };

  if (state === null) return null;
  if (state !== "unlocked")
    return <AuthScreen state={state} onDone={() => setState("unlocked")} />;

  const both = masterV + txV;
  const addToList = async (uids: string[]) => {
    const r = await window.api.preview.add(uids);
    bumpTx();
    setTab("entry");
    if (r.ok)
      show(
        r.data!.added < uids.length
          ? `${r.data!.added} added (${uids.length - r.data!.added} already in the list)`
          : `${uids.length} added to the report list`,
      );
  };
  const TABS: [Tab, string, IconName][] = [
    ["entry", "Entry", "entry"],
    ["master", masterName, "accounts"],
    ["transactions", "Transactions", "transactions"],
    ["templates", "Templates", "templates"],
    ["settings", "Settings", "settings"],
  ];

  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <span className="brand">BookKeeper</span>
        {TABS.map(([id, label, icon], i) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            aria-current={tab === id ? "page" : undefined}
            title={`${label} (Ctrl+${i + 1})${id === "master" ? " · double-click to rename" : ""}`}
            onClick={() => goTab(id)}
            onDoubleClick={
              id === "master" ? () => setRenameMaster(true) : undefined
            }
          >
            <Icon name={icon} />
            {label}
            {id === "entry" && count > 0 && (
              <span className="badge">{count}</span>
            )}
          </button>
        ))}
        <span className="spacer" />
        {unit && (
          <span className="nav-unit" title={unit.display}>
            {unit.display}
          </span>
        )}
        <button className="end" onClick={lock}>
          <Icon name="lock" />
          Lock
        </button>
      </nav>

      <main className="main">
        {/* Entry, master and transactions stay mounted so drafts, filters and scroll positions survive tab switches */}
        <section className="screen" hidden={tab !== "entry"}>
          <EntryScreen
            labels={labels}
            active={tab === "entry"}
            refreshKey={both}
            onTxChanged={bumpTx}
            onMasterChanged={bumpMaster}
            onCount={setCount}
          />
        </section>
        <section className="screen" hidden={tab !== "master"}>
          <MasterScreen
            labels={labels}
            title={masterName}
            refreshKey={masterV}
            onChanged={bumpMaster}
            onTxChanged={bumpTx}
            undoKey={both}
          />
        </section>
        <section className="screen" hidden={tab !== "transactions"}>
          <TransactionsScreen
            labels={labels}
            masterName={masterName}
            refreshKey={both}
            onAddToList={addToList}
            onChanged={bumpTx}
            onMasterChanged={bumpMaster}
          />
        </section>
        {tab === "templates" && (
          <section className="screen">
            <TemplatesScreen onChanged={bumpTx} onDirtyChange={setTplDirty} />
          </section>
        )}
        {tab === "settings" && (
          <section className="screen">
            <SettingsScreen
              labels={labels}
              masterName={masterName}
              theme={theme}
              density={density}
              onLabels={async () => {
                setLabels(await window.api.labels.get());
              }}
              onMasterName={changeMasterName}
              onTheme={changeTheme}
              onUnitChanged={loadUnit}
              onColumnsChanged={() => {
                bumpMaster();
                bumpTx();
              }}
            />
          </section>
        )}
      </main>

      {renameMaster && (
        <NameDialog
          title="Rename this tab"
          initial={masterName}
          onClose={() => setRenameMaster(false)}
          onSubmit={async (n) => {
            if (!n.trim()) return "Name cannot be empty";
            await changeMasterName(n.trim());
            return null;
          }}
        />
      )}

      {pendingTab && (
        <AskDialog
          title="Discard unsaved changes?"
          danger
          confirmLabel="Discard"
          onResult={(ok) => {
            const t = pendingTab;
            setPendingTab(null);
            if (ok) setTab(t);
          }}
        >
          <p className="muted">
            This template has changes that are not saved. Continuing will lose
            them.
          </p>
        </AskDialog>
      )}

      <Toast t={toast} onClose={hide} />
    </div>
  );
}
