import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PLAN, describePlan } from "@shared/types";
import type {
  DocMapping,
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
import DocPreviewDialog from "@/components/DocPreviewDialog";
import MapDialog from "@/components/MapDialog";
import type { MapPick } from "@/components/MapPopover";
import Icon from "@/components/Icon";
import { Toast, useToast } from "@/components/Toast";

const PLACEHOLDERS: [string, string][] = [
  [
    "{total} {total_words} {count} {today} {ref_no}",
    "Totals worked out by the app, plus the report’s Date ({today}) and Reference no ({ref_no}) as entered in the list panel. {today} is the report date, which is today unless you change it. The app adds “Rs.” before {total} and “Rupees” before {total_words} itself, so don’t type them",
  ],
  [
    "{payee} {bank} {branch} {account_no} {ifsc} {amount} {amount_words} {date} {reference_no} {utr} {notes}",
    "Details of the FIRST transaction in the list (useful for a letter about one payment). The app adds “Rs.” before {amount} and “Rupees” before {amount_words} itself, so don’t type them",
  ],
  [
    "{@table}",
    "The table built by the app. Put it alone in its own paragraph where the table should go (after the signatory for the two-page layout). Without it the table goes at the end of the letter",
  ],
  [
    "Your own texts, e.g. {signatory_name}",
    "Add them below as key + value; edit them here whenever they change",
  ],
];

const ORIGIN_LABEL = {
  none: "No Word file yet",
  prepared: "Prepared template (you wrote the placeholders)",
  mapped: "Built from your finished letter",
} as const;

const ORIGIN_SHORT = {
  none: "No Word file",
  prepared: "Prepared",
  mapped: "Mapped",
} as const;

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
  const [layoutChosen, setLayoutChosen] = useState(false); // a new template must have its layout picked before Save
  const [askDel, setAskDel] = useState(false);
  const [showDoc, setShowDoc] = useState(false); // Word preview dialog
  const [mapWork, setMapWork] = useState<{
    name: string;
    data: Uint8Array | number; // the file's bytes, or the template id when editing its stored letter
    picks: Record<string, MapPick>;
    mapping: DocMapping[]; // the same choices, ready for saveMapped
  } | null>(null); // finished letter + choices, kept on screen until Save changes
  const [askMap, setAskMap] = useState(false); // confirm replacing the template's stored Word file
  const [mapWarn, setMapWarn] = useState<{
    id: number;
    list: string[];
  } | null>(null); // advice returned by the last mapped save
  const [mapOpen, setMapOpen] = useState(false); // the mapping dialog is showing
  const [mapSaved, setMapSaved] = useState(false); // the dialog is showing this template's saved choices
  const [swap, setSwap] = useState<(() => void) | null>(null); // asks before one Word file replaces the other waiting one
  const [saved, setSaved] = useState(""); // snapshot of the last loaded or saved state; "" while loading
  const [leave, setLeave] = useState<(() => void) | null>(null); // what to do once the user agrees to discard edits
  const [draft, setDraft] = useState(false); // a new template that exists only on screen until Save
  const [staged, setStaged] = useState<{
    name: string;
    data: Uint8Array;
    warnings: string[];
  } | null>(null); // Word file picked but not stored until Save
  const busy = useRef(false); // blocks a double click on Save
  const newId = useRef<number | null>(null); // row created by a Save of a draft that failed halfway, so a retry updates it

  const { toast, show, hide } = useToast();
  const cur = list.find((t) => t.id === sel) ?? null;
  const dirty =
    (!!cur || draft) &&
    ((saved !== "" && snap(name, desc, texts, plan) !== saved) ||
      !!staged ||
      !!mapWork);
  const canSave = draft || dirty;
  const hasFile = !!staged || !!cur?.has_file;
  const shownOrigin = mapWork
    ? "mapped"
    : staged
      ? "prepared"
      : (cur?.origin ?? "none");
  const guarded = (go: () => void) => (dirty ? setLeave(() => go) : go());

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // Window title: which template is open, and whether it has unsaved edits.
  useEffect(() => {
    const label = draft ? name.trim() || "New template" : cur?.name;
    document.title = label
      ? `${label}${dirty ? " *" : ""} - Templates`
      : "BookKeeper";
    return () => {
      document.title = "BookKeeper";
    };
  }, [draft, name, cur?.name, dirty]);
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
    setStaged(null);
    setMapWork(null);
    setMapOpen(false);
    setMapSaved(false);
    if (!sel) {
      setTexts([]);
      setPlan(DEFAULT_PLAN);
      setCustomMode(false);
      setLayoutChosen(false);
      setSaved(draft ? snap("", "", [], DEFAULT_PLAN) : "");
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
      setLayoutChosen(true);
      setSaved(snap(t?.name ?? "", t?.description ?? "", tx, p));
    });
    return () => {
      stale = true;
    };
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  function create() {
    newId.current = null;
    setDraft(true);
    setStaged(null);
    setMapWork(null);
    setName("");
    setDesc("");
    setTexts([]);
    setPlan(DEFAULT_PLAN);
    setCustomMode(false);
    setLayoutChosen(false);
    setSaved(snap("", "", [], DEFAULT_PLAN));
    setSel(null);
  }

  function dropDraft() {
    newId.current = null;
    setDraft(false);
    setStaged(null);
    setMapWork(null);
    setName("");
    setDesc("");
    setTexts([]);
    setPlan(DEFAULT_PLAN);
    setSaved("");
    setSel(list[0]?.id ?? null);
  }

  async function save() {
    if (!canSave || busy.current || needLayout()) return;
    const cleanTexts = texts
      .filter((t) => t.key.trim())
      .map((t) => ({ key: t.key.trim(), value: t.value }));
    // Check the saved texts first, so a new template is never half-created by a bad key.
    const seen = new Set<string>();
    for (const t of cleanTexts) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(t.key))
        return show(
          `Invalid key "${t.key}": use lowercase letters, digits and _`,
          { tone: "error" },
        );
      if (seen.has(t.key))
        return show(`Duplicate key "${t.key}"`, { tone: "error" });
      seen.add(t.key);
    }
    busy.current = true;
    try {
      const a = await window.api.templates.save({
        id: (draft ? newId.current : sel) ?? undefined,
        name,
        description: desc,
      });
      if (!a.ok) return show(a.error ?? "Failed", { tone: "error" });
      const id = a.data!.id;
      if (draft) newId.current = id; // a retry after a later failure updates this row instead of creating another
      const b = await window.api.templates.setTexts(id, cleanTexts);
      if (!b.ok) return show(b.error ?? "Failed", { tone: "error" });
      const c = await window.api.templates.setPlan(id, plan);
      if (!c.ok) return show(c.error ?? "Failed", { tone: "error" });
      if (staged) {
        const f = await window.api.templates.setFile(id, staged.data);
        if (!f.ok) return show(f.error ?? "Failed", { tone: "error" });
      }
      // Last of all: saveMapped writes its saved texts straight to the database, so it must run after setTexts.
      let finalTexts = cleanTexts;
      if (mapWork) {
        const m = await window.api.templates.saveMapped(
          id,
          mapWork.data,
          mapWork.mapping,
        );
        if (!m.ok) return show(m.error ?? "Failed", { tone: "error" });
        finalTexts = await window.api.templates.getTexts(id);
        setMapWarn({ id, list: m.data?.warnings ?? [] });
        setMapWork(null);
      }
      setName(a.data!.name);
      setDesc(a.data!.description);
      setTexts(finalTexts);
      setPlan(c.data!);
      setStaged(null);
      setSaved(snap(a.data!.name, a.data!.description, finalTexts, c.data!));
      await load(id);
      if (draft) {
        newId.current = null;
        setDraft(false);
        setSel(id);
      }
      show("Saved");
    } finally {
      busy.current = false;
    }
  }

  const needLayout = () => {
    if (layoutChosen) return false;
    show("Choose an output layout before saving", { tone: "error" });
    return true;
  };

  const requestSave = () => {
    if (needLayout()) return;
    const replacing =
      !!cur?.has_file &&
      (!!staged || (!!mapWork && typeof mapWork.data !== "number"));
    if (replacing) setAskMap(true);
    else save();
  };

  async function doPickWord() {
    const r = await window.api.templates.pickFile();
    if (r.ok) {
      setMapWork(null);
      setMapWarn(null);
      setStaged(r.data!);
    } else if (r.error !== "Cancelled")
      show(r.error ?? "Failed", { tone: "error" });
  }
  // a finished letter waiting on screen is replaced by a prepared upload, so ask first
  const pickWord = () => (mapWork ? setSwap(() => doPickWord) : doPickWord());

  async function doPickFinished() {
    const r = await window.api.templates.pickSource();
    if (r.ok) {
      setStaged(null);
      setMapWarn(null);
      setMapWork({
        name: r.data!.name,
        data: r.data!.data,
        picks: {},
        mapping: [],
      });
      setMapOpen(true);
    } else if (r.error !== "Cancelled")
      show(r.error ?? "Failed", { tone: "error" });
  }
  // and the other way round
  const pickFinished = () =>
    staged ? setSwap(() => doPickFinished) : doPickFinished();

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
    setLayoutChosen(true);
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
              guarded(() => {
                setDraft(false);
                setSel(id);
              });
            }}
          >
            {draft && (
              <option value="" disabled>
                New template (not saved)
              </option>
            )}
            {list.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id === sel && dirty ? "● " : ""}
                {t.name}
                {t.has_file ? "" : " (no file)"}
              </option>
            ))}
          </select>
        )}
        {(cur || draft) && (
          <>
            <span className={`tplorigin ${shownOrigin}`}>
              {ORIGIN_SHORT[shownOrigin]}
            </span>
            {layoutChosen && (
              <span className="tplorigin">{describePlan(plan)}</span>
            )}
          </>
        )}
        <span className="grow" />
        {dirty && <span className="tplflag">Unsaved changes</span>}
        <button
          className="danger"
          disabled={!cur && !draft}
          onClick={() => (draft ? guarded(dropDraft) : setAskDel(true))}
        >
          {draft ? "Discard" : "Delete"}
        </button>
        <button className="primary" disabled={!canSave} onClick={requestSave}>
          Save changes
        </button>
        <button onClick={() => guarded(create)}>New template</button>
      </div>

      <div className="split">
        {cur || draft ? (
          <div
            key={draft ? "new" : String(sel)}
            className={`panel tplpanel${draft ? " isnew" : ""}${dirty ? " isdirty" : ""}`}
          >
            <div className="body">
              <div className="tplcols">
                <div className="tplmain">
                  <div className="row">
                    <div className="field">
                      <label>Name</label>
                      <input
                        className={name.trim() ? "" : "needs"}
                        placeholder="Name this template"
                        autoFocus={draft}
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
                    <span className={`tplorigin ${shownOrigin}`}>
                      {ORIGIN_LABEL[shownOrigin]}
                      {(staged || mapWork) && " — not saved yet"}
                    </span>
                    <div className="wordflows">
                      <div
                        className={`wordflow${shownOrigin === "prepared" ? ` active${staged ? " pending" : ""}` : ""}`}
                      >
                        <b>I have a prepared template</b>
                        <p className="muted">
                          A Word file where you already typed placeholders such
                          as <code>{"{total}"}</code> or{" "}
                          <code>{"{payee}"}</code>. The app fills them in
                          exactly as typed.
                        </p>
                        <button onClick={pickWord}>
                          {hasFile
                            ? "Replace with a prepared template…"
                            : "Upload prepared template…"}
                        </button>
                        {cur?.origin === "mapped" && !staged && (
                          <small>
                            This template was built from your finished letter.
                            Saving a prepared file replaces it and removes your
                            field choices.
                          </small>
                        )}
                      </div>
                      <div
                        className={`wordflow${shownOrigin === "mapped" ? ` active${mapWork ? " pending" : ""}` : ""}`}
                      >
                        <b>I have a finished letter</b>
                        <p className="muted">
                          A real letter you have already written. The app
                          suggests which amounts, names and dates could be
                          filled in for each report. You decide every one, and
                          nothing changes until you save.
                        </p>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                            alignItems: "flex-start",
                          }}
                        >
                          {!mapWork && !staged && cur?.origin === "mapped" && (
                            <button onClick={() => setMapSaved(true)}>
                              Edit choices…
                            </button>
                          )}
                          <button
                            onClick={
                              mapWork ? () => setMapOpen(true) : pickFinished
                            }
                          >
                            {mapWork
                              ? "Edit choices…"
                              : !staged && cur?.origin === "mapped"
                                ? "Choose a different letter…"
                                : "Choose a finished letter…"}
                          </button>
                          {mapWork && (
                            <button
                              className="ghost"
                              onClick={() => setMapWork(null)}
                            >
                              Discard
                            </button>
                          )}
                        </div>
                        {mapWork && (
                          <small>
                            {Object.keys(mapWork.picks).length} choice(s) from{" "}
                            {mapWork.name} are not saved yet. They are stored
                            when you click Save changes.
                          </small>
                        )}
                        {cur?.origin === "prepared" && !staged && (
                          <small>
                            This template has a prepared file. Saving choices
                            from a finished letter replaces it.
                          </small>
                        )}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        marginTop: 8,
                      }}
                    >
                      <button
                        disabled={!hasFile}
                        onClick={() => setShowDoc(true)}
                      >
                        Preview Template
                      </button>
                      <small>
                        {staged
                          ? `${staged.name} is ready and will be stored when you click Save changes.`
                          : mapWork
                            ? `${mapWork.name} is being mapped and will be stored when you click Save changes.`
                            : cur?.has_file
                              ? "A .docx is stored. Design letterhead, fonts and margins in Word."
                              : "Choose one of the two options above."}
                      </small>
                    </div>
                    {mapWarn?.id === sel &&
                      mapWarn.list.map((w, i) => (
                        <div
                          key={`m${i}`}
                          className="notice"
                          style={{ marginTop: 6 }}
                        >
                          {w}
                        </div>
                      ))}
                    {staged?.warnings.map((w, i) => (
                      <div key={i} className="notice" style={{ marginTop: 6 }}>
                        {w}
                      </div>
                    ))}
                  </div>

                  <h3 style={{ marginTop: 16 }}>Output layout</h3>
                  <div className="field">
                    <label>What this template generates</label>
                    <select
                      value={layoutChosen ? presetId : ""}
                      onChange={(e) => pickPreset(e.target.value as PresetId)}
                    >
                      {!layoutChosen && (
                        <option value="" disabled>
                          Choose a layout…
                        </option>
                      )}
                      {PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <small>
                      {layoutChosen
                        ? PRESETS.find((p) => p.id === presetId)!.hint
                        : "Choose where the table goes. Required before saving."}
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
                    templateName={name.trim() || cur?.name || "New template"}
                  />
                </aside>
              </div>
            </div>
          </div>
        ) : (
          <div className="panel pvempty">Create a template to get started.</div>
        )}
      </div>
      {showDoc && (staged || cur) && (
        <DocPreviewDialog
          title={`Preview: ${staged ? staged.name : cur!.name}`}
          source={staged ? staged.data : cur!.id}
          plan={plan}
          onClose={() => setShowDoc(false)}
        />
      )}
      {mapOpen && mapWork && (
        <MapDialog
          title={`Map: ${mapWork.name}`}
          source={mapWork.data}
          initialPicks={mapWork.picks}
          appColumns={plan.columns.filter((c) => c.on).map((c) => c.header)}
          onClose={(picks, mapping) => {
            setMapOpen(false);
            // no choices = nothing to keep
            setMapWork(
              Object.keys(picks).length ? { ...mapWork, picks, mapping } : null,
            );
          }}
        />
      )}
      {mapSaved && cur && (
        <MapDialog
          title={`Choices: ${cur.name}`}
          source={cur.id}
          appColumns={plan.columns.filter((c) => c.on).map((c) => c.header)}
          onClose={(picks, mapping, changed) => {
            setMapSaved(false);
            if (!changed) return;
            if (!Object.keys(picks).length)
              return show("No choices left, so nothing was changed.");
            setMapWork({ name: cur.name, data: cur.id, picks, mapping });
          }}
        />
      )}
      {askMap && (
        <AskDialog
          title="Replace the Word file?"
          danger
          confirmLabel="Save and replace"
          onResult={(ok) => {
            setAskMap(false);
            if (ok) save();
          }}
        >
          <p className="muted">
            {staged
              ? cur?.origin === "mapped"
                ? "This template was built from a finished letter. Saving replaces it with the prepared Word file you picked"
                : "This template already has a Word file. Saving replaces it with the prepared Word file you picked."
              : cur?.origin === "prepared"
                ? "This template uses a prepared Word file. Saving replaces it with the finished letter you chose."
                : "Saving replaces this template's letter with the different finished letter you picked."}{" "}
            Your other changes on this screen are saved too.
          </p>
        </AskDialog>
      )}
      {swap && (
        <AskDialog
          title="Use this file instead?"
          danger
          confirmLabel="Use it"
          onResult={(ok) => {
            const go = swap;
            setSwap(null);
            if (ok) go();
          }}
        >
          <p className="muted">
            A different Word file is waiting to be saved on this template. Using
            this one drops that one.
          </p>
        </AskDialog>
      )}
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
