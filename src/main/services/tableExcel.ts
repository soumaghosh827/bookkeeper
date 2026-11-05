import ExcelJS from "exceljs";
import type { TableModel } from "./reports";

/** TableModel plus the raw numbers (rupees). */
export type XlsxTable = Pick<
  TableModel,
  "columns" | "rows" | "totalLabel" | "title"
> & { amounts: number[]; totalNum: number };

const WIDTH: Record<string, number> = {
  sno: 8,
  payee: 30,
  bank: 22,
  branch: 20,
  account_no: 22,
  ifsc: 14,
  amount: 16,
  reference_no: 16,
  date: 12,
  utr: 22,
  notes: 28,
};
const THIN = { style: "thin" as const, color: { argb: "FF000000" } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/**
 * Layout: row 1 blank; row 2 = title (only when one is given, merged and centred); then the header row,
 * one row per transaction, and the GRAND TOTAL row (label merged across every column before Amount).
 */
export async function buildTableXlsx(t: XlsxTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Table");
  const n = t.columns.length;
  const ai = t.columns.findIndex((c) => c.key === "amount");

  ws.columns = t.columns.map((c) => ({
    key: c.key,
    width: WIDTH[c.key] ?? 16,
    style: {
      ...(c.key === "account_no" ? { numFmt: "@" } : {}), // keep account numbers as text
      ...(c.key === "amount"
        ? { numFmt: "#,##0.00", alignment: { horizontal: "right" as const } }
        : {}),
      ...(c.key === "sno"
        ? { alignment: { horizontal: "center" as const } }
        : {}),
    },
  }));

  let r = 2; // row 1 stays blank

  const title = (t.title ?? "").trim();
  if (title) {
    const c = ws.getCell(r, 1);
    c.value = title;
    c.font = { bold: true, size: 12 };
    c.alignment = { horizontal: "center", vertical: "middle" };
    if (n > 1) ws.mergeCells(r, 1, r, n);
    r++;
  }

  const headerRow = r;
  t.columns.forEach((col, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = col.header;
    c.font = { bold: true };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE8EDF3" },
    };
    c.border = BORDER;
  });
  r++;

  const firstData = r;
  t.rows.forEach((row, ri) => {
    row.forEach((text, i) => {
      const k = t.columns[i].key;
      const c = ws.getCell(r, i + 1);
      c.value =
        k === "sno" ? Number(text) : k === "amount" ? t.amounts[ri] : text;
      c.border = BORDER;
    });
    r++;
  });

  if (ai >= 0) {
    const rn = r;
    if (ai > 0) {
      const lc = ws.getCell(rn, 1);
      lc.value = t.totalLabel;
      if (ai > 1) ws.mergeCells(rn, 1, rn, ai);
      lc.alignment = { horizontal: "right" };
    }
    const L = ws.getColumn(ai + 1).letter;
    const tc = ws.getCell(rn, ai + 1);
    tc.value = t.rows.length
      ? { formula: `SUM(${L}${firstData}:${L}${rn - 1})`, result: t.totalNum }
      : 0;
    tc.numFmt = "#,##0.00";
    tc.alignment = { horizontal: "right" };
    for (let c = 1; c <= n; c++) {
      const cell = ws.getCell(rn, c);
      cell.font = { bold: true };
      cell.border = BORDER;
    }
  }

  ws.views = [{ state: "frozen", ySplit: headerRow }]; // blank row, title and header stay visible while scrolling
  ws.pageSetup = {
    orientation: n > 6 ? "landscape" : "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `${headerRow}:${headerRow}`,
  };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
