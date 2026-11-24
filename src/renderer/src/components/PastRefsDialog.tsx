import { useEffect, useState } from "react";
import type { TxRefInfo } from "@shared/types";
import Modal from "./Modal";

/** Lists references already used on transactions (highest number first). Click one to use it. */
export default function PastRefsDialog({
  onPick,
  onClose,
}: {
  onPick: (ref: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<TxRefInfo[] | null>(null);

  useEffect(() => {
    let stale = false; // ignore a slow reply if you typed again
    const t = setTimeout(
      async () => {
        const r = await window.api.reports.pastRefs(q.trim());
        if (!stale) setRows(r);
      },
      q ? 250 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <Modal
      title="Past transaction refs"
      onClose={onClose}
      actions={<button onClick={onClose}>Close</button>}
    >
      <div className="field">
        <input
          autoFocus
          value={q}
          maxLength={100}
          placeholder="Search reference"
          aria-label="Search reference"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div style={{ maxHeight: 320, overflowY: "auto", marginTop: 8 }}>
        {rows === null ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No references found.</p>
        ) : (
          rows.map((r) => (
            <button
              key={r.ref_no}
              type="button"
              className="ghost"
              style={{
                display: "flex",
                width: "100%",
                justifyContent: "space-between",
                gap: 12,
                textAlign: "left",
              }}
              onClick={() => onPick(r.ref_no)}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.ref_no}
              </span>
              <span
                className="muted"
                style={{ flex: "none", fontSize: "var(--fs-sm)" }}
              >
                {r.tx_count} txn{r.tx_count === 1 ? "" : "s"}
              </span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
