import type { AccField, FieldConflict } from "@shared/types";

export interface AccountCardItem {
  key: string; // key used for field choices and decisions (account number, or "#<row>")
  account_no: string;
  payee: string;
  rows: number[];
  rowCount: number;
  decisionKey?: string; // set when the account already exists and differs: shows the keep/update dropdown
  note?: string; // e.g. "Ajay Yadav · SBI · A/c 123"
  similarKey?: string; // set for a new account that looks like an existing one: shows the add/skip dropdown
  fields: FieldConflict[];
}
type Choices = Record<string, Partial<Record<AccField, string>>>;

interface Props {
  items: AccountCardItem[];
  rule: string; // bulk rule for existing accounts: "update" = the file wins, anything else = keep what is stored
  similarRule?: string; // bulk default for "looks like existing" accounts: "add" or "skip"
  decisions: Record<string, string>;
  onDecision: (decisionKey: string, value: string) => void;
  choices: Choices; // explicit picks only
  onChoice: (key: string, field: AccField, value: string) => void; // "" clears the pick
  title: string;
  hint?: string;
  maxItems?: number;
}

const nk = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase(); // same equality the backend uses
const topOf = (f: FieldConflict) => {
  const file = f.candidates
    .filter((c) => c.source === "file")
    .sort((a, b) => b.count - a.count);
  return file.length > 1 && file[0].count > file[1].count
    ? file[0].value
    : null;
};

export default function AccountConflictCard({
  items,
  rule,
  similarRule = "skip",
  decisions,
  onDecision,
  choices,
  onChoice,
  title,
  hint,
  maxItems = 100,
}: Props) {
  if (!items.length) return null;

  // what the account keeps if the user touches nothing
  const defaultOf = (g: AccountCardItem, f: FieldConflict) =>
    g.decisionKey && (decisions[g.decisionKey] ?? rule) !== "update"
      ? f.current
      : f.defaultValue;
  const chosenOf = (g: AccountCardItem, f: FieldConflict) =>
    choices[g.key]?.[f.field] ?? defaultOf(g, f);
  const pickValue = (g: AccountCardItem, f: FieldConflict, v: string) =>
    onChoice(g.key, f.field, nk(v) === nk(defaultOf(g, f)) ? "" : v); // only real deviations are stored
  const candNote = (
    f: FieldConflict,
    c: FieldConflict["candidates"][number],
  ) => {
    const parts: string[] = [];
    if (c.source === "file")
      parts.push(
        `${c.count} row${c.count > 1 ? "s" : ""}: ${c.rows.slice(0, 3).join(", ")}${c.rows.length > 3 ? "…" : ""}`,
      );
    if (c.source === "master" || (f.current && nk(c.value) === nk(f.current)))
      parts.push("current in master");
    if (c.value === topOf(f)) parts.push("most common");
    return parts.length ? ` (${parts.join(" · ")})` : "";
  };

  return (
    <div className="acc-card">
      <h3>
        {title} {hint && <small>· {hint}</small>}
      </h3>
      <div className="acc-list">
        {items.slice(0, maxItems).map((g) => (
          <div key={g.key} className="acc-block">
            <div className="acc-head">
              <b className="mono acc-no">{g.account_no || "(no account no)"}</b>
              <span className="acc-payee">{g.payee}</span>
              <span className="acc-rows">
                rows {g.rows.slice(0, 6).join(", ")}
                {g.rowCount > 6 ? ` +${g.rowCount - 6}` : ""}
              </span>
              <span className="grow" />
              {g.decisionKey && (
                <label className="acc-ctl">
                  <span>Already in master:</span>
                  <select
                    value={decisions[g.decisionKey] ?? ""}
                    onChange={(ev) =>
                      onDecision(g.decisionKey!, ev.target.value)
                    }
                  >
                    <option value="">
                      Follow the rule ({rule === "update" ? "update" : "keep"})
                    </option>
                    <option value="keep">Keep existing</option>
                    <option value="update">Update from file</option>
                  </select>
                </label>
              )}
              {g.similarKey && (
                <label className="acc-ctl">
                  <span>Looks like existing:</span>
                  <select
                    value={decisions[g.similarKey] ?? ""}
                    onChange={(ev) =>
                      onDecision(g.similarKey!, ev.target.value)
                    }
                  >
                    <option value="">Follow the rule ({similarRule})</option>
                    <option value="add">Add as new</option>
                    <option value="skip">Skip</option>
                  </select>
                </label>
              )}
            </div>
            {g.note && <div className="acc-note">Matches: {g.note}</div>}
            {g.fields.map((f) => (
              <div key={f.field} className="acc-field">
                <span className="acc-field-label">{f.label}</span>
                <div className="acc-opts">
                  {defaultOf(g, f) === "" && (
                    <label>
                      <input
                        type="radio"
                        name={`${g.key}:${f.field}`}
                        checked={chosenOf(g, f) === ""}
                        onChange={() => onChoice(g.key, f.field, "")}
                      />{" "}
                      (empty)
                    </label>
                  )}
                  {f.candidates.map((c) => (
                    <label key={c.source + c.value}>
                      <input
                        type="radio"
                        name={`${g.key}:${f.field}`}
                        checked={nk(chosenOf(g, f)) === nk(c.value)}
                        onChange={() => pickValue(g, f, c.value)}
                      />{" "}
                      {c.value}
                      <small className="muted">{candNote(f, c)}</small>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {g.fields.length > 0 && (
              <div className="acc-save">
                Will be saved:{" "}
                {g.fields
                  .map((f) => `${f.label}: ${chosenOf(g, f) || "(empty)"}`)
                  .join(" · ")}
              </div>
            )}
          </div>
        ))}
      </div>
      {items.length > maxItems && (
        <p className="muted" style={{ marginTop: 6 }}>
          Showing the first {maxItems} of {items.length.toLocaleString("en-IN")}
          . The rest follow the rules above.
        </p>
      )}
    </div>
  );
}
