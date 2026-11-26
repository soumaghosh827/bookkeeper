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
  layoutOptions,
  applyPreset,
  detectPreset,
  type PresetId,
} from "@shared/planSummary";
import { WORDS } from "@shared/words";
import PlanPreview from "@/components/PlanPreview";
import AskDialog from "@/components/AskDialog";
import DocPreviewDialog from "@/components/DocPreviewDialog";
import MapDialog from "@/components/MapDialog";
import type { MapPick } from "@/components/MapPopover";
import Icon from "@/components/Icon";
import { Toast, useToast } from "@/components/Toast";

const PLACEHOLDERS = WORDS.placeholders;

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
  useCheque,
  onUseCheque,
}: {
  onChanged: () => void;
  onDirtyChange?: (dirty: boolean) => void; // lets App ask before leaving with unsaved edits
  useCheque: boolean;
  onUseCheque: (on: boolean) => void;
}) {
  const [list, setList] = useState<Template[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [texts, setTexts] = useState<TemplateText[]>([]);
  const [plan, setPlan] = useState<OutputPlan>(DEFAULT_PLAN);
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
  const [askChq, setAskChq] = useState(false); // saved template uses {cheque_no} while the switch is off
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
  const [step, setStep] = useState(1); // 1 Name, 2 Word file, 3 Outputs, 4 Columns and texts (new templates only)
  const [staged, setStaged] = useState<{
    name: string;
    data: Uint8Array;
    warnings: string[];
  } | null>(null); // Word file picked but not stored until Save
  const busy = useRef(false); // blocks a double click on Save
  const newId = useRef<number | null>(null); // row created by a Save of a draft that failed halfway, so a retry updates it
  const beforePick = useRef<{
    plan: OutputPlan;
    staged: { name: string; data: Uint8Array; warnings: string[] } | null;
    layoutChosen: boolean;
  } | null>(null); // screen state before a finished letter was picked, so backing out can restore it

  const { toast, show, hide } = useToast();
  const cur = list.find((t) => t.id === sel) ?? null;
  const dirty =
    (!!cur || draft) &&
    ((saved !== "" && snap(name, desc, texts, plan) !== saved) ||
      !!staged ||
      !!mapWork);
  const canSave = draft || dirty;
  const hasFile = !!staged || !!cur?.has_file;
  // What the preview shows: the prepared file waiting to be saved, else the finished letter being mapped, else the stored file.
  const previewSource: Uint8Array | number | undefined = staged
    ? staged.data
    : mapWork
      ? mapWork.data
      : cur?.has_file
        ? cur.id
        : undefined;
  // Names that count as known {tags} in the template previews: saved texts, plus texts a not-yet-saved finished letter is creating
  const tagsForPreview = {
    saved: [
      ...texts.map((t) => t.key),
      ...(mapWork?.mapping ?? [])
        .filter((m) => m.kind === "text")
        .map((m) => m.tag),
    ],
  };
  const shownOrigin = mapWork
    ? "mapped"
    : staged
      ? "prepared"
      : (cur?.origin ?? "none");
  // a finished letter fixes the table position, so it never needs a layout pick
  const layoutShown = layoutChosen || shownOrigin === "mapped";
  // Saved templates show only the Word card in use. "Use a different method" brings the other one back.
  const [showOther, setShowOther] = useState(false);
  const collapse = !draft && !showOther;
  const hidePrepared = collapse && shownOrigin === "mapped";
  const hideMapped = collapse && shownOrigin === "prepared";
  useEffect(() => {
    setShowOther(false);
  }, [sel, shownOrigin]);
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
    setStep(1);
    setStaged(null);
    setMapWork(null);
    setName("");
    setDesc("");
    setTexts([]);
    setPlan(DEFAULT_PLAN);
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
    if (!canSave || busy.current) return;
    const cleanTexts = texts
      .filter((t) => t.key.trim())
      .map((t) => ({ key: t.key.trim(), value: t.value }));
    // Check the saved texts first, so a new template is never half-created by a bad key.
    const bad = textsError();
    if (bad) return show(bad, { tone: "error" });
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
      if (!useCheque && (await window.api.templates.usesCheque(id)))
        setAskChq(true);
    } finally {
      busy.current = false;
    }
  }

  // Saved-text keys must be valid and unique. Returns the message, or "" when fine.
  const textsError = () => {
    const seen = new Set<string>();
    for (const t of texts) {
      const k = t.key.trim();
      if (!k) continue;
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(k))
        return `Invalid key "${k}": use lowercase letters, digits and _`;
      if (seen.has(k)) return `Duplicate key "${k}"`;
      seen.add(k);
    }
    return "";
  };

  // quick on-screen check only; the database still refuses a duplicate name
  const nameTaken = list.some(
    (t) =>
      t.id !== sel && t.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );

  // can the user leave this step of a new template?
  const canNext = (s: number) => {
    if (s === 1) return !!name.trim() && !nameTaken;
    if (s === 2) return !!staged || !!mapWork;
    if (s === 3) return layoutShown;
    return (
      layoutShown &&
      plan.columns.every((c) => !c.on || !!c.header.trim()) &&
      !textsError()
    );
  };

  // New template only: picking a different kind of Word file makes the earlier layout choice void.
  const voidLayout = (next: "prepared" | "mapped") => {
    if (!draft || shownOrigin === next) return;
    setLayoutChosen(false);
    setPlan((p) => applyPreset(p, "one_page"));
  };

  const requestSave = () => {
    const replacing =
      !!cur?.has_file &&
      (!!staged || (!!mapWork && typeof mapWork.data !== "number"));
    if (replacing) setAskMap(true);
    else save();
  };

  async function doPickWord() {
    const r = await window.api.templates.pickFile();
    if (r.ok) {
      voidLayout("prepared");
      setMapWork(null);
      setMapWarn(null);
      setStaged(r.data!);
    } else if (r.error !== "Cancelled")
      show(r.error ?? "Failed", { tone: "error" });
  }
  // a finished letter waiting on screen is replaced by a prepared upload, so ask first
  const pickWord = () => (mapWork ? setSwap(() => doPickWord) : doPickWord());

  // Puts the screen back as it was before a finished letter was picked
  const undoPick = () => {
    const b = beforePick.current;
    beforePick.current = null;
    if (!b) return;
    setStaged(b.staged);
    setPlan(b.plan);
    setLayoutChosen(b.layoutChosen);
  };

  async function doPickFinished() {
    const r = await window.api.templates.pickSource();
    if (r.ok) {
      beforePick.current = { plan, staged, layoutChosen };
      voidLayout("mapped");
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

  const presetId: PresetId = detectPreset(plan);
  function pickPreset(id: PresetId) {
    setLayoutChosen(true);
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
            {layoutShown && (
              <span className="tplorigin">
                {describePlan(plan, shownOrigin === "mapped")}
              </span>
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
        <button
          className="primary"
          disabled={draft || !dirty}
          onClick={requestSave}
        >
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
              <div className={`tplcols${draft && step < 3 ? " solo" : ""}`}>
                <div className="tplmain">
                  <div className="tplscroll">
                    <div hidden={draft && step !== 1}>
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
                      {nameTaken && !!name.trim() && (
                        <small
                          style={{
                            display: "block",
                            color: "var(--danger)",
                            marginBottom: 12,
                          }}
                        >
                          {WORDS.steps.nameTaken}
                        </small>
                      )}
                    </div>
                    <div hidden={draft && step !== 2}>
                      <div className="field">
                        <label>Word file</label>
                        <span className={`tplorigin ${shownOrigin}`}>
                          {ORIGIN_LABEL[shownOrigin]}
                          {(staged || mapWork) && " — not saved yet"}
                        </span>
                        <div className="wordflows">
                          <div
                            className={`wordflow${shownOrigin === "prepared" ? ` active${staged ? " pending" : ""}` : ""}`}
                            style={
                              hidePrepared ? { display: "none" } : undefined
                            }
                          >
                            <b>I have a prepared template</b>
                            <p className="muted">
                              A Word file where you already typed placeholders
                              such as <code>{"{total}"}</code> or{" "}
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
                                This template was built from your finished
                                letter. Saving a prepared file replaces it and
                                removes your field choices.
                              </small>
                            )}
                          </div>
                          <div
                            className={`wordflow${shownOrigin === "mapped" ? ` active${mapWork ? " pending" : ""}` : ""}`}
                            style={hideMapped ? { display: "none" } : undefined}
                          >
                            <b>I have a finished letter</b>
                            <p className="muted">
                              A real letter you have already written. The app
                              suggests which amounts, names and dates could be
                              filled in for each report. You decide every one,
                              and nothing changes until you save.
                            </p>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                                alignItems: "flex-start",
                              }}
                            >
                              {!mapWork &&
                                !staged &&
                                cur?.origin === "mapped" && (
                                  <button onClick={() => setMapSaved(true)}>
                                    Edit choices…
                                  </button>
                                )}
                              <button
                                onClick={
                                  mapWork
                                    ? () => setMapOpen(true)
                                    : pickFinished
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
                                {Object.keys(mapWork.picks).length} choice(s)
                                from {mapWork.name} are not saved yet. They are
                                stored when you click Save changes.
                              </small>
                            )}
                            {cur?.origin === "prepared" && !staged && (
                              <small>
                                This template has a prepared file. Saving
                                choices from a finished letter replaces it.
                              </small>
                            )}
                          </div>
                        </div>
                        {collapse && shownOrigin !== "none" && (
                          <button
                            className="ghost small"
                            style={{ marginTop: 8 }}
                            onClick={() => setShowOther(true)}
                          >
                            {WORDS.steps.otherMethod}
                          </button>
                        )}
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                            marginTop: 8,
                          }}
                        >
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
                          <div
                            key={i}
                            className="notice"
                            style={{ marginTop: 6 }}
                          >
                            {w}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div hidden={draft && step !== 3}>
                      <h3 style={{ marginTop: 16 }}>Output layout</h3>
                      <div className="field">
                        <label>What this template generates</label>
                        <select
                          value={layoutShown ? presetId : ""}
                          onChange={(e) =>
                            pickPreset(e.target.value as PresetId)
                          }
                        >
                          {!layoutShown && (
                            <option value="" disabled>
                              {WORDS.layout.choose}
                            </option>
                          )}
                          {layoutOptions(shownOrigin === "mapped").map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                        <small>
                          {shownOrigin === "mapped"
                            ? WORDS.layout.mapped.hint[presetId]
                            : layoutShown
                              ? PRESETS.find((p) => p.id === presetId)!.hint
                              : WORDS.layout.chooseHint}
                        </small>
                      </div>
                    </div>
                    <div hidden={draft && step !== 4}>
                      <h3 style={{ marginTop: 16 }}>Table columns</h3>
                      <p className="muted">
                        Tick the columns for the report table, rename the
                        headers and use the arrows to reorder. Amount is always
                        included because the total needs it.
                      </p>
                      {plan.columns.map((c, i) => (
                        <div className="colrow" key={c.key}>
                          <input
                            type="checkbox"
                            checked={c.on}
                            disabled={c.key === "amount"}
                            aria-label={`Include ${c.header}`}
                            onChange={(e) =>
                              setCol(i, { on: e.target.checked })
                            }
                          />
                          <input
                            className="grow"
                            value={c.header}
                            maxLength={40}
                            aria-label="Column header"
                            onChange={(e) =>
                              setCol(i, { header: e.target.value })
                            }
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
                            setPlan((pl) => ({
                              ...pl,
                              totalLabel: e.target.value,
                            }))
                          }
                        />
                      </div>

                      <h3 style={{ marginTop: 16 }}>Saved texts</h3>
                      <p className="muted">
                        Fixed wording the template can use, such as the
                        signatory or subject line. Use the key as a placeholder,
                        e.g. <code>{"{subject_line}"}</code>.
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
                            onChange={(e) =>
                              setText(i, { value: e.target.value })
                            }
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
                  </div>
                  {draft && (
                    <div className="tplnav">
                      <button
                        disabled={step === 1}
                        onClick={() => setStep((s) => s - 1)}
                      >
                        Back
                      </button>
                      <span className="muted">Step {step} of 4</span>
                      {step < 4 ? (
                        <button
                          className="primary"
                          disabled={!canNext(step)}
                          onClick={() => setStep((s) => s + 1)}
                        >
                          Next
                        </button>
                      ) : (
                        <button
                          className="primary"
                          disabled={!canNext(4)}
                          onClick={requestSave}
                        >
                          Save
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <aside className="tplside">
                  {!(draft && step < 3) && (
                    <PlanPreview
                      plan={plan}
                      templateName={name.trim() || cur?.name || "New template"}
                      mapped={shownOrigin === "mapped"}
                      source={previewSource}
                      mapping={staged ? undefined : mapWork?.mapping}
                      tags={tagsForPreview}
                      onOpenLarger={() => setShowDoc(true)}
                    />
                  )}
                </aside>
              </div>
            </div>
          </div>
        ) : (
          <div className="panel pvempty">Create a template to get started.</div>
        )}
      </div>
      {showDoc && previewSource !== undefined && (
        <DocPreviewDialog
          title={`Preview: ${staged?.name ?? mapWork?.name ?? cur?.name ?? "template"}`}
          source={previewSource}
          mapping={staged ? undefined : mapWork?.mapping}
          plan={plan}
          mapped={shownOrigin === "mapped"}
          tags={tagsForPreview}
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
            if (Object.keys(picks).length) {
              beforePick.current = null; // keeping this letter now
              setMapWork({ ...mapWork, picks, mapping });
            } else {
              setMapWork(null);
              undoPick();
            }
          }}
          onCancel={() => {
            setMapOpen(false);
            if (beforePick.current) {
              setMapWork(null); // a freshly chosen letter: remove it and restore the screen
              undoPick();
            }
          }}
        />
      )}
      {mapSaved && cur && (
        <MapDialog
          title={`Choices: ${cur.name}`}
          source={cur.id}
          onCancel={() => setMapSaved(false)}
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
      {askChq && (
        <AskDialog
          title="Turn on cheque number?"
          confirmLabel="Turn on"
          onResult={(ok) => {
            setAskChq(false);
            if (ok) onUseCheque(true);
          }}
        >
          <p>This template uses a cheque number. Turn it on?</p>
          <p className="muted">
            Then the Entry screen has a Cheque no box. This is saved for this
            unit only.
          </p>
        </AskDialog>
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
          title="Replace the uploaded word file?"
          danger
          confirmLabel="Replace"
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
