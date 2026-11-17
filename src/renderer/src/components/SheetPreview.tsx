import type { ReportSheet } from "@shared/types";

/** The Excel output as a read-only grid: title, header row, one row per transaction, then the total row
 *  (label spans every column before Amount, like the .xlsx). */
export default function SheetPreview({
  sheet,
  zoom = 1,
  print = false,
}: {
  sheet: ReportSheet;
  zoom?: number;
  print?: boolean; // paper output: no desk backdrop
}) {
  const n = sheet.columns.length;
  const ai = sheet.columns.findIndex((c) => c.key === "amount");
  const align = (key: string) =>
    key === "amount" ? "r" : key === "sno" ? "c" : undefined;
  const title = (sheet.title ?? "").trim();
  return (
    <div className={print ? "shp-printwrap" : "shp-desk"}>
      <div className="shp" style={{ fontSize: 13 * zoom }}>
        <table className="shp-tbl">
          <thead>
            {title && (
              <tr>
                <th colSpan={n} className="shp-title">
                  {title}
                </th>
              </tr>
            )}
            <tr>
              {sheet.columns.map((c) => (
                <th key={c.key}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((t, i) => (
                  <td key={i} className={align(sheet.columns[i].key)}>
                    {t}
                  </td>
                ))}
              </tr>
            ))}
            {ai >= 0 && (
              <tr className="shp-total">
                {ai > 0 && (
                  <td colSpan={ai} className="r">
                    {sheet.totalLabel}
                  </td>
                )}
                <td className="r">{sheet.total}</td>
                {ai < n - 1 && <td colSpan={n - ai - 1} />}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
