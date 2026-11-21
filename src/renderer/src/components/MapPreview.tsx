import { useMemo } from "react";
import { DEFAULT_COLUMNS, MATCH_LABELS } from "@shared/types";
import type { DocModel, DocSuggestion } from "@shared/types";
import type { Leftover } from "@shared/leftovers";
import DocPreview, { addrKey, type DocMark } from "@/components/DocPreview";

/** The user's own Word file with the app's possibilities highlighted. Controlled: the parent holds which ones are chosen. */
export default function MapPreview({
  model,
  suggestions,
  chosen,
  onToggle,
  onOpenMark,
  onAcceptLikely,
  onClear,
  appColumns,
  advice,
  zoom = 1,
}: {
  model: DocModel;
  suggestions: DocSuggestion[];
  chosen: ReadonlySet<string>; // suggestion ids; nothing starts chosen
  onToggle: (id: string) => void; // used by the table card's button
  onOpenMark: (id: string, el: HTMLElement) => void; // a highlight on the page was clicked
  onAcceptLikely: (ids: string[]) => void; // the "likely" ones not chosen yet (never tables)
  onClear: () => void;
  appColumns?: string[]; // headers of the columns the app's table will have (the template's ticked columns)
  advice?: Leftover[]; // chosen values that still appear elsewhere in the letter (advice only)
  zoom?: number;
}) {
  // Tables are not drawn on the page; they get their own columns view.
  const inText = useMemo(
    () =>
      suggestions.filter(
        (s) =>
          s.kind !== "table" && s.start !== undefined && s.end !== undefined,
      ),
    [suggestions],
  );

  const marks = useMemo(() => {
    const m = new Map<string, DocMark[]>();
    for (const s of inText) {
      const k = addrKey(s.addr);
      const list = m.get(k) ?? [];
      list.push({
        id: s.id,
        start: s.start!,
        end: s.end!,
        tone: s.confidence,
        chosen: chosen.has(s.id),
      });
      m.set(k, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.start - b.start);
    return m;
  }, [inText, chosen]);

  const likelyOpen = inText
    .filter((s) => s.confidence === "likely" && !chosen.has(s.id))
    .map((s) => s.id);
  const tables = suggestions.filter((s) => s.kind === "table" && s.table);
  const nChosen = suggestions.filter((s) => chosen.has(s.id)).length;
  const ours =
    appColumns ?? DEFAULT_COLUMNS.filter((c) => c.on).map((c) => c.header);

  return (
    <div className="mapprev">
      <div className="mapprev-bar">
        <p className="mapprev-note">
          Please click the highlighted words in the document that you want to
          map. The highlights are only the app’s guesses. Nothing in the final
          document changes until and unless you choose it.
        </p>
        <details className="mapprev-limits">
          <summary>Good to know</summary>
          <ul>
            <li>
              Only the first transaction in a report fills the single-value
              fields (payee, account, amount and so on).
            </li>
            <li>
              The app prints its own “Rs.” before amounts, so a “Rs.” you typed
              before an amount will show twice.
            </li>
            <li>Only the last section’s header and footer can be mapped.</li>
            <li>Text boxes and tracked deletions are skipped.</li>
          </ul>
        </details>
        {advice && advice.length > 0 && (
          <details className="mapprev-limits notice">
            <summary>
              Check before saving: {advice.length} value
              {advice.length === 1 ? "" : "s"} you chose{" "}
              {advice.length === 1 ? "is" : "are"} also typed somewhere else
            </summary>
            <ul>
              {advice.map((a) => (
                <li key={a.tag + a.value}>
                  “{a.value}” ({a.label}) is also typed {a.count} more time
                  {a.count === 1 ? "" : "s"}, for example in “{a.sample}”.
                </li>
              ))}
            </ul>
            <p className="muted" style={{ margin: 0 }}>
              Those copies stay exactly as typed in every report. Choose them
              too, or edit the letter, if they should change. This is advice
              only. Spelled-out forms (for example an account number written in
              words) are not checked.
            </p>
          </details>
        )}
        <div className="mapprev-tools">
          <span className="mapprev-legend">
            <span className="muted">Colour guide:</span>
            <span className="docp-mark likely">{MATCH_LABELS.likely}</span>
            <span className="docp-mark possible">{MATCH_LABELS.possible}</span>
            <span className="docp-mark chosen first last">Chosen</span>
          </span>
          <span className="mapprev-actions">
            <span className="muted">
              Chosen: {nChosen} of {inText.length + tables.length}
            </span>
            <button
              className="small"
              disabled={likelyOpen.length === 0}
              onClick={() => onAcceptLikely(likelyOpen)}
            >
              Choose all strong matches ({likelyOpen.length})
            </button>
            <button
              className="small"
              disabled={nChosen === 0}
              onClick={onClear}
            >
              Clear choices
            </button>
          </span>
        </div>
      </div>
      {tables.map((s) => {
        const on = chosen.has(s.id);
        return (
          <section key={s.id} className={`mapprev-table${on ? " chosen" : ""}`}>
            <h4>
              {s.confidence === "likely"
                ? "A table in your file looks like the report table"
                : "A table in your file might be the report table"}
            </h4>
            <p className="muted">
              {s.reason}. It has {s.table!.rows} row
              {s.table!.rows === 1 ? "" : "s"} under the headings.
            </p>
            <div className="mapcols">
              <div>
                <b>Your columns</b>
                <ul>
                  {s.table!.headers.map((h, i) => (
                    <li key={i}>
                      {h}
                      {s.table!.matched.includes(h) && (
                        <span className="mapcols-hit">matches</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <b>The app’s columns</b>
                <ul>
                  {ours.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="notice">
              Choosing this replaces your whole table with the app’s table. The
              app builds the new table from the transactions in each report,
              using the columns on the right, so nothing of your table is kept,
              including its rows.
            </div>
            <button
              className={on ? undefined : "primary"}
              style={{ marginTop: 8 }}
              onClick={() => onToggle(s.id)}
            >
              {on ? "Keep my table" : "Replace my table with the app’s table"}
            </button>
          </section>
        );
      })}
      <DocPreview model={model} zoom={zoom} marks={marks} onPick={onOpenMark} />
    </div>
  );
}
