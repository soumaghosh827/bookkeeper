import { useEffect, useState } from "react";
import type { Labels, TxHistoryEntry, TxRow } from "@shared/types";
import { fmtDate, formatPaise } from "@shared/format";
import Modal from "./Modal";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN");

export default function HistoryDialog({
  row,
  labels,
  onClose,
}: {
  row: TxRow;
  labels: Labels;
  onClose: () => void;
}) {
  const [items, setItems] = useState<TxHistoryEntry[] | null>(null);
  useEffect(() => {
    window.api.transactions.history(row.uid).then(setItems);
  }, [row.uid]);

  const name = (k: string) =>
    (labels as unknown as Record<string, string>)[k] ??
    k.replace(/^x_/, "").replace(/_/g, " ");
  const val = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return "—";
    if (k === "amount_paise") return "₹" + formatPaise(Number(v));
    if (k === "entry_date") return fmtDate(String(v));
    return String(v);
  };
  const edits = (items ?? []).filter((i) => i.action !== "create");

  return (
    <Modal
      wide
      title="History"
      onClose={onClose}
      actions={
        <button autoFocus onClick={onClose}>
          Close
        </button>
      }
    >
      <p>
        <strong>{row.payee}</strong> · ₹{formatPaise(row.amount_paise)} ·{" "}
        {fmtDate(row.entry_date)}
      </p>
      <div style={{ maxHeight: "55vh", overflow: "auto" }}>
        {items === null && <p className="muted">Loading…</p>}
        {items !== null && edits.length === 0 && (
          <p className="muted">No changes since it was created.</p>
        )}
        {edits.map((e, i) => (
          <div
            key={i}
            style={{
              padding: "8px 0",
              borderBottom: "1px solid var(--border, #ddd)",
            }}
          >
            <div className="muted">
              {when(e.at)}
              {e.action === "delete" ? " · Deleted" : ""}
            </div>
            {Object.entries(e.changes).map(([k, [from, to]]) => (
              <div key={k}>
                <strong>{name(k)}:</strong> {val(k, from)} → {val(k, to)}
              </div>
            ))}
            {e.reason && (
              <div>
                <em>Reason: {e.reason}</em>
              </div>
            )}
          </div>
        ))}
        {items !== null && (
          <div style={{ padding: "8px 0" }} className="muted">
            {when(row.created_at)} · Created
          </div>
        )}
      </div>
    </Modal>
  );
}
