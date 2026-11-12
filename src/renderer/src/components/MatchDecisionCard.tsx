import { useState } from "react";
import {
  MATCH_CHOICES,
  MATCH_RECOMMENDED,
  type Labels,
  type TxMatchChoice,
  type TxMatchKind,
  type TxMatchRow,
} from "@shared/types";
import { fmtDate, formatPaise } from "@shared/format";

export type MatchDefaults = Partial<Record<TxMatchKind, TxMatchChoice>>;
export type MatchOverrides = Record<string, TxMatchChoice>; // keyed by Excel row number

/** What will happen to a row: its own choice, else its group's, else the recommended one. Same rule as the backend. */
export const effectiveChoice = (
  m: TxMatchRow,
  def: MatchDefaults,
  ov: MatchOverrides,
): TxMatchChoice => {
  const c = ov[String(m.row)] ?? def[m.kind] ?? MATCH_RECOMMENDED[m.kind];
  return MATCH_CHOICES[m.kind].includes(c) ? c : MATCH_RECOMMENDED[m.kind];
};

const num = (x: number) => x.toLocaleString("en-IN");
const ORDER: TxMatchKind[] = ["ref_link", "ref_differs", "blank_match"];

const KIND: Record<TxMatchKind, { title: string; issue: string }> = {
  ref_link: {
    title: "Reference number to add",
    issue:
      "Same account, amount and date as a saved transaction. The file has a reference number, the saved transaction has none.",
  },
  ref_differs: {
    title: "Different reference number",
    issue:
      "Same account, amount and date as a saved transaction, but with a different reference number. This could be a second payment or the same one.",
  },
  blank_match: {
    title: "No reference number in the file",
    issue:
      "Same account, amount and date as a saved transaction, and the file has no reference number to tell them apart.",
  },
};
const CHOICE: Record<TxMatchChoice, string> = {
  link: "Add the reference to the saved transaction",
  new: "Import as a separate transaction",
  skip: "Skip: it is already saved",
};

const resultOf = (m: TxMatchRow, c: TxMatchChoice) =>
  c === "skip"
    ? "No change"
    : c === "link"
      ? `1 transaction · ${[...m.saved.refs, m.fileRef].join(", ")}`
      : `2 transactions · saved: ${m.saved.refs.join(", ") || "no reference"}; new: ${m.fileRef || "no reference"}`;

/** Rows of the file that look like a transaction already saved: what is the issue, what is recommended, what will be the result. */
export default function MatchDecisionCard({
  matches,
  defaults,
  overrides,
  onDefault,
  onOverride,
  labels,
  maxRows = 200,
}: {
  matches: TxMatchRow[];
  defaults: MatchDefaults;
  overrides: MatchOverrides;
  onDefault: (kind: TxMatchKind, choice: TxMatchChoice) => void;
  onOverride: (row: number, choice: TxMatchChoice | null) => void;
  labels: Labels;
  maxRows?: number;
}) {
  const [open, setOpen] = useState<Set<TxMatchKind>>(new Set());
  const kinds = ORDER.filter((k) => matches.some((m) => m.kind === k));
  if (!kinds.length) return null;

  const toggle = (k: TxMatchKind) =>
    setOpen((s) => {
      const c = new Set(s);
      c.has(k) ? c.delete(k) : c.add(k);
      return c;
    });

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>
        Rows that look already saved → Transactions table{" "}
        <small>· check what should happen to each group</small>
      </h3>
      {kinds.map((kind, i) => {
        const rows = matches.filter((m) => m.kind === kind);
        const tally: Record<TxMatchChoice, number> = {
          link: 0,
          new: 0,
          skip: 0,
        };
        for (const m of rows) tally[effectiveChoice(m, defaults, overrides)]++;
        const rec = MATCH_RECOMMENDED[kind];
        const shown = open.has(kind);
        return (
          <div
            key={kind}
            style={{
              borderTop: i ? "1px solid var(--border, #ddd)" : undefined,
              paddingTop: i ? 12 : 0,
              marginTop: i ? 12 : 0,
            }}
          >
            <p style={{ margin: "0 0 4px" }}>
              <b>
                {num(rows.length)} rows · {KIND[kind].title}
              </b>
            </p>
            <p className="muted" style={{ margin: "0 0 8px" }}>
              {KIND[kind].issue}
            </p>
            <div className="field" style={{ maxWidth: 560 }}>
              <label>What should happen to this group</label>
              <select
                value={defaults[kind] ?? rec}
                onChange={(e) =>
                  onDefault(kind, e.target.value as TxMatchChoice)
                }
              >
                {MATCH_CHOICES[kind].map((c) => (
                  <option key={c} value={c}>
                    {CHOICE[c]}
                    {c === rec ? " (recommended)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="chips" style={{ margin: "8px 0" }}>
              <span className="muted">Result:</span>
              {tally.link > 0 && (
                <span className="chip ok">
                  {num(tally.link)} reference{tally.link > 1 ? "s" : ""} added
                  to saved transactions
                </span>
              )}
              {tally.new > 0 && (
                <span className="chip warn">
                  {num(tally.new)} added as separate transactions
                </span>
              )}
              {tally.skip > 0 && (
                <span className="chip">
                  {num(tally.skip)} skipped, no change
                </span>
              )}
            </div>
            <button className="small" onClick={() => toggle(kind)}>
              {shown ? "Hide rows" : "Show rows and change one by one"}
            </button>
            {shown && (
              <div style={{ maxHeight: 280, overflow: "auto", marginTop: 8 }}>
                <table className="maptable">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>{labels.account_no}</th>
                      <th>{labels.payee}</th>
                      <th>{labels.amount_paise}</th>
                      <th>{labels.entry_date}</th>
                      <th>In the file</th>
                      <th>Saved</th>
                      <th>Decision</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, maxRows).map((m) => {
                      const c = effectiveChoice(m, defaults, overrides);
                      return (
                        <tr key={m.row}>
                          <td>{m.row}</td>
                          <td className="mono">{m.account_no}</td>
                          <td>{m.payee}</td>
                          <td style={{ textAlign: "right" }}>
                            {formatPaise(m.amount_paise)}
                          </td>
                          <td>{fmtDate(m.entry_date)}</td>
                          <td>
                            {m.fileRef || (
                              <span className="muted">no reference</span>
                            )}
                          </td>
                          <td>
                            {m.saved.refs.join(", ") || (
                              <span className="muted">no reference</span>
                            )}
                          </td>
                          <td>
                            <select
                              value={overrides[String(m.row)] ?? ""}
                              onChange={(e) =>
                                onOverride(
                                  m.row,
                                  (e.target.value as TxMatchChoice) || null,
                                )
                              }
                            >
                              <option value="">Same as the group</option>
                              {MATCH_CHOICES[kind].map((x) => (
                                <option key={x} value={x}>
                                  {CHOICE[x]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="muted">{resultOf(m, c)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {rows.length > maxRows && (
                  <p className="muted" style={{ marginTop: 6 }}>
                    Showing the first {num(maxRows)} of {num(rows.length)}. The
                    rest follow the group choice.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
