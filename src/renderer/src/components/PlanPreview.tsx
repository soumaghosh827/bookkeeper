import type { OutputPlan, TablePlacement } from "@shared/types";
import { summarizePlan } from "@shared/planSummary";

/** The table as it will look: your column headers, two sample rows, and the GRAND TOTAL row. `title` adds the optional title bar above it. */
function SketchTable({ plan, title }: { plan: OutputPlan; title?: boolean }) {
  const cols = plan.columns.filter((c) => c.on);
  const ai = cols.findIndex((c) => c.key === "amount");
  return (
    <div className="pp-tblwrap">
      {title && <div className="pp-title" title="Optional table title" />}
      <table className="pp-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[0, 1].map((i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.key} className={c.key === "amount" ? "r" : ""}>
                  …
                </td>
              ))}
            </tr>
          ))}
          <tr className="tot">
            {ai > 0 && (
              <td colSpan={ai} className="r">
                {plan.totalLabel}
              </td>
            )}
            <td className="r">0.00</td>
            {ai < cols.length - 1 && <td colSpan={cols.length - 1 - ai} />}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const Lines = ({ n }: { n: number }) => (
  <div className="pp-lines">
    {Array.from({ length: n }, (_, i) => (
      <i key={i} />
    ))}
  </div>
);
const Sign = () => (
  <div className="pp-sign">
    <i />
    <i />
  </div>
);

function WordSketch({
  plan,
  table,
}: {
  plan: OutputPlan;
  table: TablePlacement;
}) {
  if (table === "new_page")
    return (
      <>
        <div className="pp-page mid">
          <Lines n={7} />
          <Sign />
        </div>
        <div className="pp-page">
          <SketchTable plan={plan} title />
        </div>
      </>
    );
  if (table === "none")
    return (
      <div className="pp-page mid">
        <Lines n={7} />
        <Sign />
      </div>
    );
  return (
    <div className="pp-page mid">
      <Lines n={3} />
      <SketchTable plan={plan} title />
      <Sign />
    </div>
  );
}

function ExcelSketch({ plan }: { plan: OutputPlan }) {
  return (
    <div className="pp-sheet">
      <div className="pp-band">Row 1: blank</div>
      <div className="pp-band">Row 2: title (only if you enter one)</div>
      <SketchTable plan={plan} />
    </div>
  );
}

/** Read-only answer to "what will this template generate?". Used in the Templates tab and on the Entry screen. */
export default function PlanPreview({
  plan,
  templateName,
}: {
  plan: OutputPlan;
  templateName: string;
}) {
  const s = summarizePlan(plan, templateName);
  return (
    <div className="pp">
      <div className="pp-head">
        <strong>{s.presetLabel}</strong>
        <span className="muted">{s.oneLine}</span>
      </div>
      {plan.outputs.map((o, i) => (
        <section key={o.id} className="pp-out">
          <header>
            <span className={`pp-kind ${o.kind}`}>
              {o.kind === "xlsx" ? "Excel" : "Word"}
            </span>
            <span className="name" title={s.outputs[i].fileName}>
              {s.outputs[i].fileName}
            </span>
          </header>
          <div className="pp-body">
            {o.kind === "xlsx" ? (
              <ExcelSketch plan={plan} />
            ) : (
              <WordSketch plan={plan} table={o.table} />
            )}
          </div>
          <div className="pp-note">{s.outputs[i].note}</div>
        </section>
      ))}
    </div>
  );
}
