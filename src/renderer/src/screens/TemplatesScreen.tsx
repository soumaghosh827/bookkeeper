import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PLAN } from "@shared/types";
import type {
  OutputPlan,
  TableColumn,
  Template,
  TemplateText,
} from "@shared/types";
import {
  PRESETS,
  applyPreset,
  detectPreset,
  type PresetId,
} from "@shared/planSummary";
import PlanPreview from "@/components/PlanPreview";
import AskDialog from "@/components/AskDialog";
import Icon from "@/components/Icon";
import { Toast, useToast } from "@/components/Toast";

const PLACEHOLDERS: [string, string][] = [
  [
    "{total} {total_words} {count} {today} {ref_no}",
    "Totals worked out by the app, plus the report’s Date ({today}) and Reference no ({ref_no}) as entered in the list panel. {today} is the report date, which is today unless you change it",
  ],
  [
    "{payee} {bank} {branch} {account_no} {ifsc} {amount} {amount_words} {date} {reference_no} {utr} {notes}",
    "Details of the FIRST transaction in the list (useful for a letter about one payment)",
  ],
  [
    "{@table}",
    "The table built by the app. Put it alone in its own paragraph where the table should go (after the signatory for the two-page layout). Without it the table goes at the end of the letter",
  ],
  [
    "{#items} … {/items}",
    "Put the start tag in the first cell and the end tag in the last cell of ONE table row; that row repeats for every transaction",
  ],
  [
    "{sno} {payee} {bank} {branch} {account_no} {ifsc} {amount} {reference_no} {date} {utr} {notes}",
    "Inside the repeating row: values of each transaction",
  ],
  [
    "Your own texts, e.g. {signatory_name}",
    "Add them below as key + value; edit them here whenever they change",
  ],
];

const snap = (n: string, d: string, t: TemplateText[], p: OutputPlan) =>
  JSON.stringify([n, d, t, p]);

export default function TemplatesScreen({
  onChanged,
  onDirtyChange,
}: {
  onChanged: () => void;
  onDirtyChange?: (dirty: boolean) => void; // lets App ask before leaving with unsaved edits
}) {
  const [list, setList] = useState<Template[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [texts, setTexts] = useState<TemplateText[]>([]);
  const [plan, setPlan] = useState<OutputPlan>(DEFAULT_PLAN);
  const [customMode, setCustomMode] = useState(false); // keeps "Custom" selected even if the outputs happen to match a layout
  const [askDel, setAskDel] = useState(false);
  const [saved, setSaved] = useState(""); // snapshot of the last loaded or saved state; "" while loading
  const [leave, setLeave] = useState<(() => void) | null>(null); // what to do once the user agrees to discard edits

  const { toast, show, hide } = useToast();
  const cur = list.find((t) => t.id === sel) ?? null;
  const dirty =
    !!cur && saved !== "" && snap(name, desc, texts, plan) !== saved;
  const guarded = (go: () => void) => (dirty ? setLeave(() => go) : go());

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(
    async (keep?: number | null) => {
      const l = await window.api.templates.list();
      setList(l);
      onChanged();
      return l.find((t) => t.id === keep) ? keep! : (l[0]?.id ?? null);
    },
    [onChanged],
  );

  useEffect(() => {
    load(null).then(setSel);
  }, [load]);

  useEffect(() => {
    const t = list.find((x) => x.id === sel);
    setName(t?.name ?? "");
    setDesc(t?.description ?? "");
    setSaved("");
    if (!sel) {
      setTexts([]);
      setPlan(DEFAULT_PLAN);
      return;
    }
    let stale = false;
    Promise.all([
      window.api.templates.getTexts(sel),
      window.api.templates.getPlan(sel),
    ]).then(([tx, p]) => {
      if (stale) return;
      setTexts(tx);
      setPlan(p);
      setCustomMode(detectPreset(p) === "custom");
      setSaved(snap(t?.name ?? "", t?.description ?? "", tx, p));
    });
    return () => {
      stale = true;
    };
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    const r = await window.api.templates.save({
      name: "New template",
      description: "",
    });
    if (r.ok) {
      await load(r.data!.id);
      setSel(r.data!.id);
    } else show(r.error ?? "Failed", { tone: "error" });
  }

  async function save() {
    if (!sel) return;
    const a = await window.api.templates.save({
      id: sel,
      name,
      description: desc,
    });
    if (!a.ok) return show(a.error ?? "Failed", { tone: "error" });
    const cleanTexts = texts
      .filter((t) => t.key.trim())
      .map((t) => ({ key: t.key.trim(), value: t.value }));
    const b = await window.api.templates.setTexts(sel, cleanTexts);
    if (!b.ok) return show(b.error ?? "Failed", { tone: "error" });
    const c = await window.api.templates.setPlan(sel, plan);
    if (!c.ok) return show(c.error ?? "Failed", { tone: "error" });
    setName(a.data!.name);
    setDesc(a.data!.description);
    setTexts(cleanTexts);
    setPlan(c.data!);
    setSaved(snap(a.data!.name, a.data!.description, cleanTexts, c.data!));
    await load(sel);
    show("Saved");
  }

  async function upload() {
    if (!sel) return;
    const r = await window.api.templates.uploadFile(sel);
    if (r.ok) {
      await load(sel);
      show("Word file stored in the encrypted database");
    } else if (r.error !== "Cancelled")
      show(r.error ?? "Failed", { tone: "error" });
  }

  async function remove() {
    setAskDel(false);
    await window.api.templates.remove(sel!);
    setSel(await load(null));
  }

  const setCol = (i: number, p: Partial<TableColumn>) =>
    setPlan((pl) => ({
      ...pl,
      columns: pl.columns.map((c, j) => (j === i ? { ...c, ...p } : c)),
    }));

  const moveCol = (i: number, d: -1 | 1) =>
    setPlan((pl) => {
      const j = i + d;
      if (j < 0 || j >= pl.columns.length) return pl;
      const cols = pl.columns.slice();
      [cols[i], cols[j]] = [cols[j], cols[i]];
      return { ...pl, columns: cols };
    });

  const presetId: PresetId = customMode ? "custom" : detectPreset(plan);
  function pickPreset(id: PresetId) {
    if (id === "custom") return setCustomMode(true);
    setCustomMode(false);
    setPlan((p) => applyPreset(p, id));
  }

  const setText = (i: number, p: Partial<TemplateText>) =>
    setTexts((t) => t.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <>
      <div className="toolbar">
        <h2>Templates</h2>
        {list.length > 0 && (
          <select
            className="tplpick"
            aria-label="Template"
            value={sel ?? ""}
            onChange={(e) => {
              const id = Number(e.target.value);
              guarded(() => setSel(id));
            }}
          >
            {list.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.has_file ? "" : " (no file)"}
              </option>
            ))}
          </select>
        )}
        <span className="grow" />
        {dirty && <span className="tplflag">Unsaved changes</span>}
        <button
          className="danger"
          disabled={!cur}
          onClick={() => setAskDel(true)}
        >
          Delete
        </button>
        <button className="primary" disabled={!dirty} onClick={save}>
          Save changes
        </button>
        <button onClick={() => guarded(create)}>New template</button>
      </div>

      <div className="split">
        {cur ? (
          <div className="panel tplpanel">
            <div className="body">
              <div className="tplcols">
                <div className="tplmain">
                  <div className="row">
                    <div className="field">
                      <label>Name</label>
                      <input
                        value={name}
                        maxLength={80}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>Description</label>
                      <input
                        value={desc}
                        maxLength={300}
                        onChange={(e) => setDesc(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>Word file</label>
                    <div
                      style={{ display: "flex", gap: 8, alignItems: "center" }}
                    >
                      <button onClick={upload}>
                        {cur.has_file
                          ? "Replace Word file…"
                          : "Upload Word file…"}
                      </button>
                      <small>
                        {cur.has_file
                          ? "A .docx is stored. Design letterhead, fonts and margins in Word."
                          : "Upload a .docx designed in Word, with placeholders in curly braces."}
                      </small>
                    </div>
                  </div>

                  <h3 style={{ marginTop: 16 }}>Output layout</h3>
                  <div className="field">
                    <label>What this template generates</label>
                    <select
                      value={presetId}
                      onChange={(e) => pickPreset(e.target.value as PresetId)}
                    >
                      {PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <small>
                      {PRESETS.find((p) => p.id === presetId)!.hint}
                    </small>
                  </div>

                  <h3 style={{ marginTop: 16 }}>Table columns</h3>
                  <p className="muted">
                    Tick the columns for the report table, rename the headers
                    and use the arrows to reorder. Amount is always included
                    because the total needs it.
                  </p>
                  {plan.columns.map((c, i) => (
                    <div className="colrow" key={c.key}>
                      <input
                        type="checkbox"
                        checked={c.on}
                        disabled={c.key === "amount"}
                        aria-label={`Include ${c.header}`}
                        onChange={(e) => setCol(i, { on: e.target.checked })}
                      />
                      <input
                        className="grow"
                        value={c.header}
                        maxLength={40}
                        aria-label="Column header"
                        onChange={(e) => setCol(i, { header: e.target.value })}
                      />
                      <button
                        className="ghost small icon"
                        title="Move up"
                        aria-label="Move up"
                        disabled={i === 0}
                        onClick={() => moveCol(i, -1)}
                      >
                        <Icon name="arrowUp" />
                      </button>
                      <button
                        className="ghost small icon"
                        title="Move down"
                        aria-label="Move down"
                        disabled={i === plan.columns.length - 1}
                        onClick={() => moveCol(i, 1)}
                      >
                        <Icon name="arrowDown" />
                      </button>
                    </div>
                  ))}
                  <div className="field" style={{ marginTop: 12 }}>
                    <label>Total row label</label>
                    <input
                      value={plan.totalLabel}
                      maxLength={40}
                      onChange={(e) =>
                        setPlan((pl) => ({ ...pl, totalLabel: e.target.value }))
                      }
                    />
                  </div>

                  <h3 style={{ marginTop: 16 }}>Saved texts</h3>
                  <p className="muted">
                    Fixed wording the template can use, such as the signatory or
                    subject line. Use the key as a placeholder, e.g.{" "}
                    <code>{"{subject_line}"}</code>.
                  </p>
                  {texts.map((t, i) => (
                    <div className="kv" key={i}>
                      <input
                        className="mono"
                        placeholder="key (a-z, 0-9, _)"
                        value={t.key}
                        onChange={(e) =>
                          setText(i, { key: e.target.value.toLowerCase() })
                        }
                      />
                      <input
                        placeholder="Text"
                        value={t.value}
                        onChange={(e) => setText(i, { value: e.target.value })}
                      />
                      <button
                        className="ghost icon"
                        title="Remove"
                        aria-label="Remove"
                        onClick={() =>
                          setTexts((x) => x.filter((_, j) => j !== i))
                        }
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  ))}
                  <button
                    className="small"
                    onClick={() =>
                      setTexts((x) => [...x, { key: "", value: "" }])
                    }
                  >
                    <Icon name="add" className="ic-inline" /> Add text
                  </button>

                  <div className="help" style={{ marginTop: 16 }}>
                    <b>Placeholders you can use in the Word file</b>
                    <ul>
                      {PLACEHOLDERS.map(([p, d]) => (
                        <li key={p}>
                          <code>{p}</code> — {d}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                <aside className="tplside">
                  <PlanPreview
                    plan={plan}
                    templateName={name.trim() || cur.name}
                  />
                </aside>
              </div>
            </div>
          </div>
        ) : (
          <div className="panel pvempty">Create a template to get started.</div>
        )}
      </div>
      {askDel && (
        <AskDialog
          title="Delete this template?"
          danger
          confirmLabel="Delete"
          onResult={(ok) => (ok ? remove() : setAskDel(false))}
        >
          <p className="muted">Reports already saved stay in the database.</p>
        </AskDialog>
      )}
      {leave && (
        <AskDialog
          title="Discard unsaved changes?"
          danger
          confirmLabel="Discard"
          onResult={(ok) => {
            const go = leave;
            setLeave(null);
            if (ok) go();
          }}
        >
          <p className="muted">
            This template has changes that are not saved. Continuing will lose
            them.
          </p>
        </AskDialog>
      )}
      <Toast t={toast} onClose={hide} />
    </>
  );
}
