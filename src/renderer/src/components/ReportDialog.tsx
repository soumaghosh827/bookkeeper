import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import type { DocModel, ReportFile, ReportPrepared } from "@shared/types";
import { formatPaise, rupeesInWords } from "@shared/format";
import DocPreview from "@/components/DocPreview";
import SheetPreview from "@/components/SheetPreview";
import Modal from "@/components/Modal";

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5];
const A4 = { width: 595.3, height: 841.9 }; // points
const nextPaint = () =>
  new Promise<void>((res) =>
    requestAnimationFrame(() => requestAnimationFrame(() => res())),
  );

// Excel output: A4 with 0.5" margins, landscape when the table is wide
const sheetPage = (cols: number) => {
  const land = cols >= 7;
  return {
    width: land ? A4.height : A4.width,
    height: land ? A4.width : A4.height,
    margin: { top: 36, right: 36, bottom: 36, left: 36 },
  };
};

export default function ReportDialog({
  templateId,
  uids,
  refNo,
  chequeNo,
  reportDate,
  initial,
  warnings,
  already,
  onSaved,
  onClose,
  onClearList,
}: {
  templateId: number;
  uids: string[];
  refNo: string;
  chequeNo: string; // sent again on every re-prepare, or the saved report would lose it
  reportDate: string; // ISO
  initial: ReportPrepared; // from the first prepare
  warnings: string[];
  already: number; // how many of these transactions already have a saved report
  onSaved: () => void; // a report was recorded: refresh the lists
  onClose: () => void; // the parent discards the prepared report and closes
  onClearList: () => void | Promise<void>;
}) {
  const [prepared, setPrepared] = useState(initial);
  const [title, setTitle] = useState("");
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.files.map((f) => [f.id, f.fileName])),
  );
  const record = true; // every report is saved to the database (no opt-out)
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false); // re-preparing after a title change
  const [broken, setBroken] = useState(false); // the last re-prepare failed: nothing valid is prepared
  const [printing, setPrinting] = useState(false); // the print-only copy is mounted
  const [locked, setLocked] = useState(false); // recorded: the title can no longer change the report
  const [err, setErr] = useState<string>();
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState("");
  const [tab, setTab] = useState(initial.files[0].id);
  const [zoom, setZoom] = useState(1);
  const [doc, setDoc] = useState<{
    for: ReportPrepared;
    id: string;
    model: DocModel;
  } | null>(null);
  const [docErr, setDocErr] = useState("");
  const [extra, setExtra] = useState(false); // also make a separate Excel table
  const lastKey = useRef("|0"); // the title and Excel choice the current preparation was built with

  const active: ReportFile =
    prepared.files.find((f) => f.id === tab) ?? prepared.files[0];

  // title or "also Excel" changed: prepare again (debounced) so the preview and the saved files match
  useEffect(() => {
    const key = `${title}|${extra ? 1 : 0}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    let stale = false;
    setRefreshing(true);
    const t = setTimeout(async () => {
      const p = await window.api.reports.prepare(
        templateId,
        uids,
        title,
        refNo,
        reportDate,
        extra,
        chequeNo,
      );
      if (stale) return;
      setRefreshing(false);
      if (p.ok) {
        setPrepared(p.data!);
        setBroken(false);
        setErr(undefined);
      } else {
        setBroken(true);
        setErr(p.error);
      }
    }, 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [title, extra]); // eslint-disable-line react-hooks/exhaustive-deps

  // Word tab: the model of the generated file
  useEffect(() => {
    if (active.kind !== "docx") return;
    let stale = false;
    window.api.reports
      .preview(active.id)
      .then((r) => {
        if (stale) return;
        if (r.ok && r.data) {
          setDoc({ for: prepared, id: active.id, model: r.data });
          setDocErr("");
        } else setDocErr(r.error ?? "Could not draw the preview");
      })
      .catch((e) => !stale && setDocErr((e as Error).message));
    return () => {
      stale = true;
    };
  }, [prepared, active.id, active.kind]);

  const docReady = doc?.for === prepared && doc.id === active.id && !docErr;
  const idle = !broken && !refreshing && !busy && !printing;
  const canPrint = idle && (active.kind === "xlsx" || docReady);

  async function doSave(): Promise<string | null> {
    const r = await window.api.reports.save(record, names);
    if (!r.ok) {
      if (r.error !== "Cancelled") setErr(r.error);
      return null;
    }
    onSaved(); // the "reports" column changed
    return r.data!.path;
  }

  async function doPrint() {
    const page =
      active.kind === "docx" && doc
        ? doc.model.page
        : sheetPage(active.sheet?.columns.length ?? 0);
    flushSync(() => setPrinting(true)); // mount the print-only copy, then let it paint
    await nextPaint();
    const r = await window.api.reports.print(active.id, record, page);
    setPrinting(false);
    if (r.ok) {
      setNote("Sent to the printer.");
      if (r.data!.recorded) {
        setLocked(true);
        onSaved();
      }
    } else if (r.error !== "Cancelled") setErr(r.error);
  }

  async function onSave(thenPrint: boolean) {
    if (busy) return;
    setBusy(true);
    setErr(undefined);
    setNote("");
    const path = await doSave();
    if (path) {
      if (thenPrint) await doPrint();
      setSaved(path);
    }
    setBusy(false);
  }

  async function onPrint() {
    if (busy) return;
    setBusy(true);
    setErr(undefined);
    setNote("");
    await doPrint();
    setBusy(false);
  }

  const i = ZOOMS.indexOf(zoom);
  const multi = prepared.files.length > 1;

  return (
    <>
      <Modal
        title={saved ? "Report saved" : "Generate report"}
        wide={!saved}
        onClose={onClose}
        locked={busy || printing || refreshing}
        actions={
          saved ? (
            <>
              <button onClick={onClose}>Keep list</button>
              <button className="primary" onClick={() => onClearList()}>
                Clear list
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={busy || printing || refreshing}
              >
                Cancel
              </button>
              <button disabled={!canPrint} onClick={onPrint}>
                Print
              </button>
              <button disabled={!canPrint} onClick={() => onSave(true)}>
                Save and print
              </button>
              <button
                className="primary"
                autoFocus
                disabled={!idle}
                onClick={() => onSave(false)}
              >
                {multi ? "Choose folder…" : "Save as…"}
              </button>
            </>
          )
        }
      >
        {saved ? (
          <>
            <p className="notice ok">Saved to {saved}</p>
            {note && <p className="muted">{note}</p>}
            <p className="muted">
              Clear the list to start the next batch, or keep it to generate
              again.
            </p>
          </>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(260px, 320px) minmax(0, 1fr)",
              gap: 16,
              height: "100%",
            }}
          >
            <div style={{ overflowY: "auto", minHeight: 0, paddingRight: 4 }}>
              <p>
                <strong>{prepared.templateName}</strong>
              </p>
              <p>
                {prepared.count} transactions · total{" "}
                <b>₹{formatPaise(prepared.total_paise)}</b>
                <br />
                <small>{rupeesInWords(prepared.total_paise)}</small>
              </p>
              {already > 0 && (
                <p className="notice">
                  {already} of these already have a saved report.
                </p>
              )}
              {warnings.map((w, k) => (
                <p key={k} className="notice">
                  {w}
                </p>
              ))}
              <p className="muted">
                Nothing is written until you save or print. The preview shows
                the finished report.
              </p>
              {prepared.canAddExcel && (
                <label className="check" style={{ marginTop: 12 }}>
                  <input
                    type="checkbox"
                    checked={extra}
                    disabled={locked || busy || refreshing || printing}
                    onChange={(e) => setExtra(e.target.checked)}
                  />{" "}
                  Also save the table as a separate Excel file
                </label>
              )}
              <div className="field" style={{ marginTop: 12 }}>
                <label>Table title (optional, centred above the table)</label>
                <input
                  value={title}
                  maxLength={120}
                  disabled={locked || busy}
                  placeholder="e.g. Payment details"
                  onChange={(e) => setTitle(e.target.value)}
                />
                {locked && (
                  <small>
                    The title is locked once the report is saved to the
                    database.
                  </small>
                )}
              </div>
              {multi && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>File names</label>
                  {prepared.files.map((f) => (
                    <input
                      key={f.id}
                      style={{ marginBottom: 6 }}
                      value={names[f.id] ?? f.fileName}
                      maxLength={110}
                      aria-label={
                        f.kind === "xlsx" ? "Excel file name" : "Word file name"
                      }
                      onChange={(e) =>
                        setNames({ ...names, [f.id]: e.target.value })
                      }
                    />
                  ))}
                </div>
              )}
              {/* <label className="check">
                <input
                  type="checkbox"
                  checked={record}
                  disabled={locked}
                  onChange={(e) => setRecord(e.target.checked)}
                />{" "}
                Save report to database (so we know these transactions have a
                report)
              </label> */}
              {note && <p className="notice ok">{note}</p>}
              {err && <p className="error">{err}</p>}
            </div>

            <div
              style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                {multi &&
                  prepared.files.map((f) => (
                    <button
                      key={f.id}
                      className={f.id === active.id ? "small primary" : "small"}
                      onClick={() => setTab(f.id)}
                    >
                      {f.kind === "xlsx" ? "Excel" : "Word"}
                    </button>
                  ))}
                <span style={{ flex: 1 }} />
                <button
                  className="small"
                  aria-label="Zoom out"
                  disabled={i <= 0}
                  onClick={() => setZoom(ZOOMS[i - 1])}
                >
                  −
                </button>
                <button
                  className="small"
                  title="Back to 100%"
                  style={{ minWidth: 56 }}
                  onClick={() => setZoom(1)}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  className="small"
                  aria-label="Zoom in"
                  disabled={i >= ZOOMS.length - 1}
                  onClick={() => setZoom(ZOOMS[i + 1])}
                >
                  +
                </button>
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflow: "auto",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  opacity: refreshing ? 0.5 : 1,
                }}
              >
                {active.kind === "xlsx" && active.sheet ? (
                  <SheetPreview sheet={active.sheet} zoom={zoom} />
                ) : docErr ? (
                  <div className="notice">{docErr}</div>
                ) : doc && doc.id === active.id ? (
                  <DocPreview model={doc.model} zoom={zoom} />
                ) : (
                  <p className="muted" style={{ padding: 12 }}>
                    Drawing the preview…
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>
      {printing &&
        createPortal(
          <div className="print-root">
            {active.kind === "xlsx" && active.sheet ? (
              <SheetPreview sheet={active.sheet} print />
            ) : doc ? (
              <DocPreview model={doc.model} print />
            ) : null}
          </div>,
          document.body,
        )}
    </>
  );
}
