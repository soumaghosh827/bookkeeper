import { useEffect, useState } from "react";
import type { DocModel } from "@shared/types";
import DocPreview from "@/components/DocPreview";
import Modal from "@/components/Modal";

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Read-only preview of a Word file. `source` = the file's bytes, or the id of a stored template. */
export default function DocPreviewDialog({
  title,
  source,
  onClose,
}: {
  title: string;
  source: Uint8Array | number;
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
      ) : model ? (
        <DocPreview model={model} zoom={zoom} />
      ) : (
        <p className="muted">Reading the file…</p>
      )}
    </Modal>
  );
}
