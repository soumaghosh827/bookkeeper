import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAP_TAG_LABELS, MATCH_LABELS } from "@shared/types";
import type { DocMapping, DocSuggestion } from "@shared/types";

export type MapPick = Pick<DocMapping, "kind" | "tag">; // what the user chose for one suggestion

type Mode = "field" | "text" | "keep";

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
// Names the app fills itself (the main process refuses them too; this only explains early).
const RESERVED = new Set([...Object.keys(MAP_TAG_LABELS), "sno", "table"]);

function keyError(key: string, text: string, used: Record<string, string>) {
  if (!key) return "";
  if (!KEY_RE.test(key))
    return "Use lowercase letters, digits and _, starting with a letter (up to 40 characters).";
  if (RESERVED.has(key))
    return `“${key}” is a name the app fills itself. Pick another name for this text.`;
  if (used[key] !== undefined && used[key] !== text)
    return `“${key}” is already used for different wording in this letter.`;
  if (text.length > 2000) return "This text is longer than 2000 characters.";
  return "";
}

/** Small box next to a highlight: what should the app do with this text? Nothing is stored here; the parent decides. */
export default function MapPopover({
  suggestion: s,
  anchor,
  current,
  usedKeys,
  onApply,
  onClose,
}: {
  suggestion: DocSuggestion;
  anchor: HTMLElement; // the highlighted piece that was clicked
  current: MapPick | undefined; // what is chosen now; undefined = nothing yet (Keep)
  usedKeys: Record<string, string>; // saved-text names used by OTHER choices -> their wording
  onApply: (pick: MapPick | null) => void; // null = Keep
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // A strong match opens on "Fill from report", anything else on "No change". Nothing is chosen until Apply.
  const strongField = s.kind === "field" && s.confidence === "likely";
  const [mode, setMode] = useState<Mode>(
    current
      ? current.kind === "text"
        ? "text"
        : "field"
      : strongField
        ? "field"
        : "keep",
  );
  const [field, setField] = useState(
    current?.kind === "field"
      ? current.tag
      : strongField && Object.hasOwn(MAP_TAG_LABELS, s.tag)
        ? s.tag
        : "",
  );
  const [key, setKey] = useState(
    current?.kind === "text" ? current.tag : s.kind === "text" ? s.tag : "",
  );

  // Place the box under the highlight (above it when there is no room), inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6;
    const top =
      below + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : below;
    setPos({ top, left });
  }, [anchor, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation(); // closes this box only, not the dialog under it
      onClose();
    };
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", outside);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const suggested = s.options.filter((t) => Object.hasOwn(MAP_TAG_LABELS, t));
  const others = Object.keys(MAP_TAG_LABELS).filter(
    (t) => !suggested.includes(t),
  );
  const err = mode === "text" ? keyError(key, s.text, usedKeys) : "";
  const canApply =
    mode === "keep" || (mode === "field" ? !!field : !!key && !err);
  const shown = s.text.length > 120 ? s.text.slice(0, 119) + "…" : s.text;

  function apply() {
    if (!canApply) return;
    onApply(
      mode === "keep"
        ? null
        : mode === "field"
          ? { kind: "field", tag: field }
          : { kind: "text", tag: key },
    );
  }

  return (
    <div
      ref={ref}
      className="mappop"
      role="dialog"
      aria-label="What should the app do with this text?"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="mappop-text">“{shown}”</div>
      <div className="muted">
        {s.reason} · {MATCH_LABELS[s.confidence]}
      </div>

      <label className="mappop-opt">
        <input
          type="radio"
          name="mappop-mode"
          checked={mode === "keep"}
          onChange={() => setMode("keep")}
        />
        No change
      </label>

      <label className="mappop-opt">
        <input
          type="radio"
          name="mappop-mode"
          checked={mode === "field"}
          onChange={() => setMode("field")}
        />
        Fill from report
      </label>
      {mode === "field" && (
        <>
          <select value={field} onChange={(e) => setField(e.target.value)}>
            <option value="" disabled>
              Choose a field…
            </option>
            {suggested.length > 0 && (
              <optgroup label="Suggested for this text">
                {suggested.map((t) => (
                  <option key={t} value={t}>
                    {MAP_TAG_LABELS[t]}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={suggested.length > 0 ? "Other fields" : "Fields"}>
              {others.map((t) => (
                <option key={t} value={t}>
                  {MAP_TAG_LABELS[t]}
                </option>
              ))}
            </optgroup>
          </select>
          {MAP_TAG_LABELS[field]?.startsWith("First") && (
            <small>
              Filled from the first transaction in each report; the others are
              not used here.
            </small>
          )}
        </>
      )}

      <label className="mappop-opt">
        <input
          type="radio"
          name="mappop-mode"
          checked={mode === "text"}
          onChange={() => setMode("text")}
        />
        Same text on every report (saved text)
      </label>
      {mode === "text" && (
        <>
          <input
            className="mono"
            value={key}
            maxLength={40}
            placeholder="name, e.g. signatory_name"
            onChange={(e) => setKey(e.target.value.toLowerCase())}
          />
          {err ? (
            <div className="mappop-err">{err}</div>
          ) : (
            <small>
              This wording is saved under this name and printed on every report.
              If this template already has a saved text with this name, it is
              replaced.
            </small>
          )}
        </>
      )}

      <div className="mappop-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!canApply} onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  );
}
