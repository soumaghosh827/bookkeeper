import { useState } from "react";
import type { DocMapping, OutputPlan } from "@shared/types";
import { useLetterPreview } from "@/lib/useLetterPreview";
import DocPreview, { type DocTags } from "@/components/DocPreview";
import Modal from "@/components/Modal";
import { WORDS } from "@shared/words";

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Read-only preview of a Word file. `source` = the file's bytes, or the id of a stored template. */
export default function DocPreviewDialog({
  title,
  source,
  plan,
  mapped = false,
  mapping,
  tags,
  onClose,
}: {
  title: string;
  source: Uint8Array | number;
  plan?: OutputPlan; // when given, the preview shows the table where this layout puts it
  mapped?: boolean; // finished letter: never mention {@table}
  mapping?: DocMapping[]; // unsaved finished letter: its choices, shown applied
  tags?: DocTags; // template preview: show {tags} as chips
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const { shown, error, note } = useLetterPreview(
    source,
    plan,
    mapped,
    mapping,
  );
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
          {tags && (
            <p className="muted" style={{ margin: "0 0 8px" }}>
              {WORDS.preview.tagsLegend}
            </p>
          )}
          <DocPreview model={shown} zoom={zoom} tags={tags} />
        </>
      ) : (
        <p className="muted">Reading the file…</p>
      )}
    </Modal>
  );
}
