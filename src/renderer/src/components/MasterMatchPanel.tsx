import type { Account, Labels, SearchKey } from "@shared/types";

function Hl({ text, tok }: { text: string; tok: string }) {
  if (!tok || !text) return <>{text}</>;
  const i = text.toLowerCase().indexOf(tok.toLowerCase());
  return i < 0 ? (
    <>{text}</>
  ) : (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + tok.length)}</mark>
      {text.slice(i + tok.length)}
    </>
  );
}

export interface Typed {
  payee: string;
  account_no: string;
  ifsc: string;
}

/** Mirrors the save-time check (findSimilar): same account number is the strong match, same name + IFSC the soft one. */
function flagOf(a: Account, t: Typed): string {
  const acc = t.account_no.replace(/\s/g, "");
  if (acc && a.account_no === acc) return "Same account number";
  const ifsc = t.ifsc.trim().toUpperCase();
  if (
    ifsc &&
    a.ifsc === ifsc &&
    a.payee.trim().toLowerCase() === t.payee.trim().toLowerCase()
  )
    return "Same name and IFSC";
  return "";
}

/** "Already in Master": accounts that match what is being typed in the add bar. Information only; it never blocks Add. */
export default function MasterMatchPanel({
  items,
  field,
  text,
  typed,
  labels,
  masterName,
  onPick,
}: {
  items: Account[];
  field: SearchKey;
  text: string;
  typed: Typed;
  labels: Labels;
  masterName: string;
  onPick: (a: Account) => void;
}) {
  const hl = (k: SearchKey, v: string) => (
    <Hl text={v} tok={field === k ? text : ""} />
  );
  return (
    <div className="mm" onMouseDown={(e) => e.preventDefault()}>
      <div className="mm-title">Already in {masterName}</div>
      <div className="mm-row mm-head">
        <div>{labels.payee}</div>
        <div>{labels.bank}</div>
        <div>{labels.branch}</div>
        <div>{labels.account_no}</div>
        <div>{labels.ifsc}</div>
        <div />
      </div>
      {items.map((a) => (
        <div
          key={a.id}
          className="mm-row"
          title="Show this account in the list below"
          onClick={() => onPick(a)}
        >
          <div>{hl("payee", a.payee)}</div>
          <div>{a.bank}</div>
          <div>{a.branch}</div>
          <div className="mono">{hl("account_no", a.account_no)}</div>
          <div className="mono">{hl("ifsc", a.ifsc)}</div>
          <div className="mm-flag">{flagOf(a, typed)}</div>
        </div>
      ))}
      <div className="mm-foot">
        Click a row to show it in the list · <kbd>Esc</kbd> closes · Add still
        works
      </div>
    </div>
  );
}
