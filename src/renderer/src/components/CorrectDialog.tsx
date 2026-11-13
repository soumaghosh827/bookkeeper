import { useState, type ReactNode } from "react";
import { CORRECT_FREE_HOURS, canCorrectFreely } from "@shared/rules";
import Modal from "./Modal";

export interface CorrectAuth {
  password?: string;
  reason?: string;
}
export type Changes = Record<string, unknown>;

export interface CorrectField {
  key: string;
  label: string;
  /** Stored value; the parsed input is compared against it to detect a change. */
  value: unknown;
  /** Text shown in the input. */
  text: string;
  /** Shown as "(was …)". */
  was: string;
  maxLength?: number;
  /** Defaults to trimming the text. */
  parse?: (text: string) => { value: unknown } | { error: string };
}

/** onSubmit returns: true = saved (close), false = user cancelled a confirmation (stay open), string = error to show. */
export default function CorrectDialog({
  title,
  noun,
  subject,
  createdAt,
  fields,
  onSubmit,
  onClose,
}: {
  title: string;
  noun: string;
  subject: ReactNode;
  createdAt: string;
  fields: CorrectField[];
  onSubmit: (changes: Changes, auth: CorrectAuth) => Promise<boolean | string>;
  onClose: () => void;
}) {
  const needsAuth = !canCorrectFreely(createdAt);
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.text])),
  );
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function go() {
    if (busy) return;
    const changes: Changes = {};
    for (const f of fields) {
      const t = texts[f.key] ?? "";
      const p = f.parse ? f.parse(t) : { value: t.trim() };
      if ("error" in p) return setErr(p.error);
      if (p.value !== f.value) changes[f.key] = p.value;
    }
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
      title={title}
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
      <p>{subject}</p>
      {fields.map((f, i) => (
        <div className="field" key={f.key}>
          <label>
            {f.label} <span className="muted">(was {f.was})</span>
          </label>
          <input
            autoFocus={i === 0}
            maxLength={f.maxLength}
            value={texts[f.key] ?? ""}
            onChange={(e) =>
              setTexts((t) => ({ ...t, [f.key]: e.target.value }))
            }
            onKeyDown={enter}
          />
        </div>
      ))}
      {needsAuth && (
        <>
          <div className="notice" style={{ marginBottom: 8 }}>
            This {noun} is more than {CORRECT_FREE_HOURS} hours old. Enter a
            reason and your password. The change is recorded in its history.
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
