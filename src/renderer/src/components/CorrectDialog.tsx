import { useState } from "react";
import type { Labels, TxChanges, TxRow } from "@shared/types";
import { CORRECT_FREE_HOURS, canCorrectFreely } from "@shared/rules";
import { fmtDate, formatPaise, parseAmount, parseDate } from "@shared/format";
import Modal from "./Modal";

export interface CorrectAuth {
  password?: string;
  reason?: string;
}
type Changes = Pick<TxChanges, "amount_paise" | "entry_date" | "reference_no">;

/** onSubmit returns: true = saved (close), false = user cancelled a confirmation (stay open), string = error to show. */
export default function CorrectDialog({
  row,
  labels,
  onSubmit,
  onClose,
}: {
  row: TxRow;
  labels: Labels;
  onSubmit: (changes: Changes, auth: CorrectAuth) => Promise<boolean | string>;
  onClose: () => void;
}) {
  const needsAuth = !canCorrectFreely(row.created_at);
  const [amount, setAmount] = useState(formatPaise(row.amount_paise));
  const [date, setDate] = useState(fmtDate(row.entry_date));
  const [ref, setRef] = useState(row.reference_no);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function go() {
    if (busy) return;
    const a = parseAmount(amount);
    if (!a.ok) return setErr(`${labels.amount_paise} is not valid`);
    const d = parseDate(date);
    if (!d) return setErr(`${labels.entry_date} is not valid (use dd/mm/yyyy)`);
    const changes: Changes = {};
    if ((a.paise ?? 0) !== row.amount_paise)
      changes.amount_paise = a.paise ?? 0;
    if (d !== row.entry_date) changes.entry_date = d;
    if (ref.trim() !== row.reference_no) changes.reference_no = ref.trim();
    if (!Object.keys(changes).length) return setErr("Nothing has changed");
    if (needsAuth && !reason.trim()) return setErr("Please give a reason");
    if (needsAuth && !password) return setErr("Please enter your password");
    setBusy(true);
    setErr("");
    const r = await onSubmit(
      changes,
      needsAuth ? { password, reason: reason.trim() } : {},
    );
    setBusy(false);
    if (r === true) onClose();
    else if (typeof r === "string") setErr(r);
  }
  const enter = (e: React.KeyboardEvent) => e.key === "Enter" && go();

  return (
    <Modal
      title="Correct this transaction"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={go}>
            Save correction
          </button>
        </>
      }
    >
      <p>
        <strong>{row.payee}</strong>
      </p>
      <div className="field">
        <label>
          {labels.amount_paise}{" "}
          <span className="muted">(was ₹{formatPaise(row.amount_paise)})</span>
        </label>
        <input
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>
          {labels.entry_date}{" "}
          <span className="muted">(was {fmtDate(row.entry_date)})</span>
        </label>
        <input
          value={date}
          onChange={(e) => setDate(e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>
          {labels.reference_no}{" "}
          <span className="muted">(was {row.reference_no || "blank"})</span>
        </label>
        <input
          maxLength={100}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={enter}
        />
      </div>
      {needsAuth && (
        <>
          <div className="notice" style={{ marginBottom: 8 }}>
            This transaction is more than {CORRECT_FREE_HOURS} hours old. Enter
            a reason and your password. The change is recorded in its history.
          </div>
          <div className="field">
            <label>Reason</label>
            <input
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={enter}
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={enter}
            />
          </div>
        </>
      )}
      {err && <p className="error">{err}</p>}
    </Modal>
  );
}
