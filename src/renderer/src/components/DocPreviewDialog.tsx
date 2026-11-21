import { useEffect, useMemo, useState } from "react";
import type { DocModel, OutputPlan } from "@shared/types";
import { withLayout, wordPlacement } from "@shared/layoutPreview";
import DocPreview from "@/components/DocPreview";
import Modal from "@/components/Modal";

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Read-only preview of a Word file. `source` = the file's bytes, or the id of a stored template. */
export default function DocPreviewDialog({
  title,
  source,
  plan,
  onClose,
}: {
  title: string;
  source: Uint8Array | number;
  plan?: OutputPlan; // when given, the preview shows the table where this layout puts it
  onClose: () => void;
}) {
  const [model, setModel] = useState<DocModel | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let stale = false;
    setModel(null);
    setError("");
    window.api.templates
      .inspect(source)
      .then((r) => {
        if (stale) return;
        if (r.ok && r.data) setModel(r.data);
        else setError(r.error ?? "Could not read this file");
      })
      .catch((e) => {
        if (!stale)
          setError((e as Error).message || "Could not read this file");
      });
    return () => {
      stale = true;
    };
  }, [source]);

  const placement = plan ? wordPlacement(plan) : null;
  const shown = useMemo(
    () =>
      model && plan && placement ? withLayout(model, plan, placement) : model,
    [model, plan, placement],
  );
  const note =
    !plan || !placement
      ? ""
      : placement === "inline"
        ? "Sample table shown where {@table} is in the letter (at the end if there is none)."
        : placement === "new_page"
          ? "Sample table shown on a new page after the letter."
          : plan.outputs.some((o) => o.kind === "xlsx")
            ? "The letter has no table. The table goes to a separate Excel file."
            : "The letter has no table.";
  const i = ZOOMS.indexOf(zoom);
  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
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
          <button onClick={onClose}>Close</button>
        </>
      }
    >
      {error ? (
        <div className="notice">{error}</div>
      ) : shown ? (
        <>
          {note && (
            <div className="notice" style={{ marginBottom: 8 }}>
              {note}
            </div>
          )}
          <DocPreview model={shown} zoom={zoom} />
        </>
      ) : (
        <p className="muted">Reading the file…</p>
      )}
    </Modal>
  );
}
