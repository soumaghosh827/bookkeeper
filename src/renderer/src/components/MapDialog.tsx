import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DocAnalysis,
  DocMapping,
  DocModel,
  DocSuggestion,
} from "@shared/types";
import { buildMapping, picksFromMapping } from "@shared/mapChoices";
import DocPreview from "@/components/DocPreview";
import MapPopover, { type MapPick } from "@/components/MapPopover";
import MapPreview from "@/components/MapPreview";
import Modal from "@/components/Modal";

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// A stable text form of the picks, to tell whether anything changed since the dialog opened.
const sig = (p: Record<string, MapPick>) =>
  JSON.stringify(Object.entries(p).sort(([a], [b]) => (a < b ? -1 : 1)));

// MapPick (what the user chose for one suggestion) lives in MapPopover.tsx
const defaultPick = (s: DocSuggestion): MapPick => ({
  kind: s.kind,
  tag: s.tag,
});

/** Opens the user's own Word file for mapping. `source` = the file's bytes, or a template id (use its stored source). */
export default function MapDialog({
  title,
  source,
  initialPicks,
  appColumns,
  onClose,
}: {
  title: string;
  source: Uint8Array | number;
  initialPicks?: Record<string, MapPick>; // choices made earlier, so closing and re-opening resumes
  appColumns?: string[]; // headers of the template's ticked table columns; the app's defaults when omitted
  onClose: (
    picks: Record<string, MapPick>,
    mapping: DocMapping[],
    changed: boolean, // anything different from what the dialog opened with
  ) => void; // always hands back the current choices, and the same choices ready for saveMapped
}) {
  const [data, setData] = useState<DocAnalysis | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  // suggestion id -> what the user chose for it. Nothing starts chosen; Keep = no entry.
  const [picks, setPicks] = useState<Record<string, MapPick>>(
    initialPicks ?? {},
  );
  const chosen = useMemo(() => new Set(Object.keys(picks)), [picks]);
  const [open, setOpen] = useState<{ id: string; el: HTMLElement } | null>(
    null,
  ); // the highlight whose popover is showing
  const [filled, setFilled] = useState<DocModel | null>(null); // "See it filled": the letter with sample data
  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState("");
  const [dropped, setDropped] = useState(0); // saved choices that match nothing in the file any more
  const baseline = useRef(sig(initialPicks ?? {})); // the picks the dialog opened with

  useEffect(() => {
    let stale = false;
    setData(null);
    setError("");
    setPicks(initialPicks ?? {});
    setOpen(null);
    setFilled(null);
    setFillError("");
    setDropped(0);
    baseline.current = sig(initialPicks ?? {});
    window.api.templates
      .analyze(source)
      .then((r) => {
        if (stale) return;
        if (r.ok && r.data) {
          setData(r.data);
          // Opened from a template: show its saved choices, unless choices are already in progress.
          if (
            !(initialPicks && Object.keys(initialPicks).length) &&
            r.data.mapping.length
          ) {
            const back = picksFromMapping(r.data.suggestions, r.data.mapping);
            setPicks(back.picks);
            setDropped(back.dropped);
            baseline.current = sig(back.picks);
          }
        } else setError(r.error ?? "Could not read this file");
      })
      .catch((e) => {
        if (!stale)
          setError((e as Error).message || "Could not read this file");
      });
    return () => {
      stale = true;
    };
  }, [source]);

  const toggle = (id: string) => {
    const s = data?.suggestions.find((x) => x.id === id);
    if (!s) return;
    setPicks((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = defaultPick(s);
      return next;
    });
  };

  const openS = open
    ? data?.suggestions.find((s) => s.id === open.id)
    : undefined;
  // saved-text names used by OTHER choices, with their wording, so the popover can refuse two wordings under one name
  const usedKeys: Record<string, string> = {};
  for (const s of data?.suggestions ?? [])
    if (s.id !== open?.id && picks[s.id]?.kind === "text")
      usedKeys[picks[s.id].tag] = s.text;

  // Runs the current choices on made-up transactions. Stores nothing.
  async function seeFilled() {
    if (!data) return;
    setFilling(true);
    setFillError("");
    try {
      const r = await window.api.templates.testFill(
        source,
        buildMapping(data.suggestions, picks),
      );
      if (r.ok && r.data) setFilled(r.data);
      else setFillError(r.error ?? "Could not fill the letter");
    } catch (e) {
      setFillError((e as Error).message || "Could not fill the letter");
    } finally {
      setFilling(false);
    }
  }

  const apply = (id: string, pick: MapPick | null) => {
    setPicks((prev) => {
      const next = { ...prev };
      if (pick) next[id] = pick;
      else delete next[id];
      return next;
    });
    setOpen(null);
  };

  const finish = () =>
    onClose(
      picks,
      data ? buildMapping(data.suggestions, picks) : [],
      sig(picks) !== baseline.current || dropped > 0,
    );
  const i = ZOOMS.indexOf(zoom);
  return (
    <Modal
      title={title}
      wide
      onClose={finish}
      actions={
        <>
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
            onClick={() => setZoom(1)}
            style={{ minWidth: 56 }}
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
          <span style={{ flex: 1 }} />
          <button
            disabled={
              !data || filling || (!filled && Object.keys(picks).length === 0)
            }
            title={
              !filled && Object.keys(picks).length === 0
                ? "Choose at least one highlight first"
                : undefined
            }
            onClick={filled ? () => setFilled(null) : seeFilled}
          >
            {filled
              ? "Back to my choices"
              : filling
                ? "Filling…"
                : "See it filled"}
          </button>
          <button className="primary" onClick={finish}>
            Done
          </button>
        </>
      }
    >
      {error ? (
        <div className="notice">{error}</div>
      ) : data && filled ? (
        <>
          <div className="mapprev-bar">
            <p className="mapprev-note">
              <b>Sample only.</b> This is your letter filled with made-up
              details, not real transactions, so you can check where each value
              lands. Nothing is saved. Use “Back to my choices” to change
              anything.
            </p>
          </div>
          <DocPreview model={filled} zoom={zoom} />
        </>
      ) : data ? (
        <>
          {fillError && (
            <div className="notice bad" style={{ margin: 12 }}>
              {fillError}
            </div>
          )}
          {dropped > 0 && (
            <div className="notice" style={{ margin: 12 }}>
              {dropped} earlier choice{dropped === 1 ? "" : "s"} could not be
              matched to this file and {dropped === 1 ? "was" : "were"} left
              out. Choose {dropped === 1 ? "it" : "them"} again if you still
              need {dropped === 1 ? "it" : "them"}.
            </div>
          )}
          <MapPreview
            model={data.model}
            suggestions={data.suggestions}
            chosen={chosen}
            onToggle={toggle}
            onOpenMark={(id, el) => setOpen({ id, el })}
            onAcceptLikely={(ids) =>
              setPicks((prev) => {
                const next = { ...prev };
                for (const s of data.suggestions)
                  if (ids.includes(s.id)) next[s.id] = defaultPick(s);
                return next;
              })
            }
            onClear={() => setPicks({})}
            appColumns={appColumns}
            zoom={zoom}
          />
          {open && openS && (
            <MapPopover
              key={open.id}
              suggestion={openS}
              anchor={open.el}
              current={picks[open.id]}
              usedKeys={usedKeys}
              onApply={(p) => apply(open.id, p)}
              onClose={() => setOpen(null)}
            />
          )}
        </>
      ) : (
        <p className="muted">Reading the file…</p>
      )}
    </Modal>
  );
}
