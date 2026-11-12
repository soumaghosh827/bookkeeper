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

/** The user sees two answers; the engine choice behind "same payment" depends on what the row brings. */
type Answer = "same" | "separate";
const answerOf = (c: TxMatchChoice): Answer =>
  c === "new" ? "separate" : "same";
const choiceFor = (kind: TxMatchKind, a: Answer): TxMatchChoice =>
  a === "separate" ? "new" : kind === "ref_link" ? "link" : "skip";

const num = (x: number) => x.toLocaleString("en-IN");
const noRef = <span className="muted">no reference</span>;

const resultOf = (m: TxMatchRow, c: TxMatchChoice) => {
  if (c === "new") return "Imported as a separate transaction";
  if (c === "link" && m.target.type === "saved")
    return `Reference added · ${[...m.target.refs, m.fileRef].join(", ")}`;
  return "Not imported, no change";
};

/** File rows that look like another transaction (a saved one, or an earlier row of the same file). Every row has a safe default. */
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
  const [open, setOpen] = useState(false);
  if (!matches.length) return null;

  const eff = matches.map((m) => effectiveChoice(m, defaults, overrides));
  const tally = { link: 0, new: 0, skip: 0 };
  for (const c of eff) tally[c]++;
  const allRec = matches.every((m, i) => eff[i] === MATCH_RECOMMENDED[m.kind]);
  const bulk = allRec
    ? "rec"
    : eff.every((c) => c !== "new")
      ? "same"
      : eff.every((c) => c === "new")
        ? "separate"
        : "mixed";

  const applyBulk = (v: string) => {
    const kinds = [...new Set(matches.map((m) => m.kind))];
    for (const k of kinds)
      onDefault(
        k,
        v === "rec" ? MATCH_RECOMMENDED[k] : choiceFor(k, v as Answer),
      );
  };

  // saved targets first, then repeats inside the file; stable by row
  const sorted = matches
    .map((m, i) => ({ m, c: eff[i] }))
    .sort(
      (a, b) =>
        (a.m.target.type === "saved" ? 0 : 1) -
          (b.m.target.type === "saved" ? 0 : 1) || a.m.row - b.m.row,
    );

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>
        Possible duplicates ({num(matches.length)}){" "}
        <small>· each row already has a safe default</small>
      </h3>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        These rows have the same account, amount and date as another
        transaction: a saved one, or an earlier row of this file. Review them
        only if something looks wrong.
      </p>
      <div className="field" style={{ maxWidth: 360 }}>
        <label>For all these rows</label>
        <select value={bulk} onChange={(e) => applyBulk(e.target.value)}>
          <option value="rec">Recommended for each row</option>
          <option value="same">Same payment for all</option>
          <option value="separate">Separate payment for all</option>
          {bulk === "mixed" && (
            <option value="mixed" disabled>
              Mixed (set row by row)
            </option>
          )}
        </select>
      </div>
      <div className="chips" style={{ margin: "8px 0" }}>
        <span className="muted">Result:</span>
        {tally.link > 0 && (
          <span className="chip ok">
            {num(tally.link)} reference{tally.link > 1 ? "s" : ""} added to
            saved transactions
          </span>
        )}
        {tally.new > 0 && (
          <span className="chip warn">
            {num(tally.new)} imported as separate transactions
          </span>
        )}
        {tally.skip > 0 && (
          <span className="chip">
            {num(tally.skip)} not imported, no change
          </span>
        )}
      </div>
      <button className="small" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide rows" : "Review rows one by one"}
      </button>
      {open && (
        <div style={{ maxHeight: 320, overflow: "auto", marginTop: 8 }}>
          <table className="maptable">
            <thead>
              <tr>
                <th>Row</th>
                <th>{labels.account_no}</th>
                <th>{labels.payee}</th>
                <th>{labels.amount_paise}</th>
                <th>{labels.entry_date}</th>
                <th>In the file</th>
                <th>Matches</th>
                <th>Decision</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, maxRows).map(({ m, c }) => (
                <tr key={m.row}>
                  <td>{m.row}</td>
                  <td className="mono">{m.account_no}</td>
                  <td>{m.payee}</td>
                  <td style={{ textAlign: "right" }}>
                    {formatPaise(m.amount_paise)}
                  </td>
                  <td>{fmtDate(m.entry_date)}</td>
                  <td>{m.fileRef || noRef}</td>
                  <td>
                    {m.target.type === "saved" ? (
                      <>Saved: {m.target.refs.join(", ") || noRef}</>
                    ) : (
                      <>
                        Row {m.target.row} of this file: {m.target.ref || noRef}
                      </>
                    )}
                  </td>
                  <td>
                    <select
                      value={answerOf(c)}
                      onChange={(e) =>
                        onOverride(
                          m.row,
                          choiceFor(m.kind, e.target.value as Answer),
                        )
                      }
                    >
                      <option value="same">Same payment</option>
                      <option value="separate">Separate payment</option>
                    </select>
                  </td>
                  <td className="muted">{resultOf(m, c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {matches.length > maxRows && (
            <p className="muted" style={{ marginTop: 6 }}>
              Showing the first {num(maxRows)} of {num(matches.length)}. The
              rest follow the bulk choice.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
