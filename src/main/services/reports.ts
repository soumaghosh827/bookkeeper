import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import type { DB } from "../db";
import {
  normalizePlan,
  type OutputPlan,
  type ReportPrepared,
  type Result,
  type TableColumn,
  type TablePlacement,
  type TxRow,
  type OutputSpec,
} from "@shared/types";
import {
  fmtDate,
  formatPaise,
  parseDate,
  rupeesInWords,
  todayIso,
} from "@shared/format";
import { addReference, cleanRef } from "./txReferences";
import { getRowsByUids } from "./transactions";
import { explain, getTemplateFile, getTexts } from "./templates";
import { buildTableXlsx } from "./tableExcel";

/**
 * Placeholders available in a template (documented in the Templates screen):
 *  - saved texts of the template:        {signatory_name} {subject_line} ...
 *  - totals:                             {total} {total_words} {count} {today} {ref_no}
 *  - first transaction (single bills):   {payee} {bank} {branch} {account_no} {ifsc} {amount} {amount_words} {date} {reference_no} {utr} {notes}
 *  - the table built by the app:         {@table} alone in its own paragraph (placement and columns come from the template's output plan)
 *  - hand-made table (older method):     one template row wrapped in {#items} ... {/items}
 */
interface PendingFile {
  id: string;
  kind: "docx" | "xlsx";
  fileName: string;
  buffer: Buffer;
}
interface Pending {
  files: PendingFile[];
  templateId: number;
  templateName: string;
  uids: string[];
  total: number;
  refNo: string; // one reference for the whole report ('' = none)
  reportDate: string; // YYYY-MM-DD
}
let pending: Pending | null = null;

const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim()
    .slice(0, 80) || "Report";

// ---------- the table: one model, rendered to Word now and to Excel / the editable preview later ----------
export interface TableModel {
  columns: { key: TableColumn["key"]; header: string }[];
  rows: string[][];
  totalLabel: string;
  total: string;
  amounts: number[]; // rupees, one per row (for Excel)
  totalNum: number; // rupees (for Excel)
  title?: string; // optional centred heading above the table
}

const CELL: Record<TableColumn["key"], (r: TxRow, i: number) => string> = {
  sno: (_r, i) => String(i + 1),
  payee: (r) => r.payee,
  bank: (r) => r.bank,
  branch: (r) => r.branch,
  account_no: (r) => r.account_no,
  ifsc: (r) => r.ifsc,
  amount: (r) => formatPaise(r.amount_paise),
  reference_no: (r) => r.reference_no,
  date: (r) => fmtDate(r.entry_date),
  utr: (r) => r.utr,
  notes: (r) => r.notes,
};

export function buildTableModel(
  rows: TxRow[],
  plan: OutputPlan,
  title = "",
): TableModel {
  const cols = plan.columns.filter((c) => c.on);
  const totalPaise = rows.reduce((n, r) => n + r.amount_paise, 0);
  return {
    columns: cols.map((c) => ({ key: c.key, header: c.header })),
    rows: rows.map((r, i) => cols.map((c) => CELL[c.key](r, i))),
    totalLabel: plan.totalLabel,
    total: formatPaise(totalPaise),
    amounts: rows.map((r) => r.amount_paise / 100),
    totalNum: totalPaise / 100,
    title: title.trim(),
  };
}

const xmlEsc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const WEIGHT: Record<string, number> = {
  sno: 5,
  payee: 19,
  bank: 15,
  branch: 14,
  account_no: 19,
  ifsc: 15,
  amount: 16,
  reference_no: 13,
  date: 11,
  utr: 16,
  notes: 19,
};
const ALIGN: Record<string, string> = { sno: "center", amount: "right" };

function cell(
  text: string,
  o: {
    w: number;
    span?: number;
    bold?: boolean;
    align?: string;
    fill?: string;
  },
) {
  const pr =
    `<w:tcW w:w="${o.w}" w:type="pct"/>${o.span && o.span > 1 ? `<w:gridSpan w:val="${o.span}"/>` : ""}` +
    `${o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : ""}<w:vAlign w:val="center"/>`;
  const run = text
    ? `<w:r><w:rPr>${o.bold ? "<w:b/>" : ""}<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`
    : "";
  return `<w:tc><w:tcPr>${pr}</w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/><w:jc w:val="${o.align ?? "left"}"/></w:pPr>${run}</w:p></w:tc>`;
}

/** WordprocessingML for the table (header row repeats on every page; rows never split across pages). '' when there is nothing to insert. */
export function docxTableXml(m: TableModel, placement: TablePlacement): string {
  if (placement === "none" || !m.columns.length) return "";
  const weights = m.columns.map((c) => WEIGHT[c.key] ?? 12);
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = weights.map((x) => Math.round((x / sum) * 5000)); // widths in fiftieths of a percent: the table always fills the text width
  const span = (a: number, b: number) =>
    w.slice(a, b).reduce((x, y) => x + y, 0);
  const line = (n: string) =>
    `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;

  const head = `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${m.columns.map((c, i) => cell(c.header, { w: w[i], bold: true, align: "center" })).join("")}</w:tr>`;
  const body = m.rows
    .map(
      (r) =>
        `<w:tr><w:trPr><w:cantSplit/></w:trPr>${r.map((t, i) => cell(t, { w: w[i], align: ALIGN[m.columns[i].key] })).join("")}</w:tr>`,
    )
    .join("");

  // last row: label right-aligned across every column before Amount, then the total in the Amount column
  const ai = m.columns.findIndex((c) => c.key === "amount");
  let total = "";
  if (ai >= 0) {
    let cells = "";
    if (ai > 0)
      cells += cell(m.totalLabel, {
        w: span(0, ai),
        span: ai,
        bold: true,
        align: "right",
      });
    cells += cell(m.total, { w: w[ai], bold: true, align: "right" });
    if (ai < m.columns.length - 1)
      cells += cell("", {
        w: span(ai + 1, w.length),
        span: m.columns.length - ai - 1,
      });
    total = `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells}</w:tr>`;
  }

  // New page: the title paragraph itself starts the page; with no title a hair-thin empty paragraph does.
  const title = (m.title ?? "").trim();
  const heading = title
    ? `<w:p><w:pPr><w:keepNext/>${placement === "new_page" ? "<w:pageBreakBefore/>" : ""}<w:spacing w:before="120" w:after="80"/><w:jc w:val="center"/></w:pPr>` +
      `<w:r><w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve">${xmlEsc(title)}</w:t></w:r></w:p>`
    : placement === "new_page"
      ? '<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>'
      : "";
  const tbl =
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(line).join("")}</w:tblBorders>` +
    `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="70" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${w.map((x) => `<w:gridCol w:w="${Math.round(x * 1.8)}"/>`).join("")}</w:tblGrid>${head}${body}${total}</w:tbl>`;
  // Word needs a paragraph after a table (a table cannot be the last thing in the document)
  return `${heading}${tbl}<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>`;
}

/** No {@table} marker in the Word file: put the table at the end of the document body. */
export function appendTableAtEnd(zip: PizZip, tableXml: string) {
  const f = zip.file("word/document.xml");
  if (!f) return;
  let xml = f.asText();
  const at =
    xml.lastIndexOf("<w:sectPr") >= 0
      ? xml.lastIndexOf("<w:sectPr")
      : xml.lastIndexOf("</w:body>");
  if (at < 0) return;
  xml = xml.slice(0, at) + tableXml + xml.slice(at);
  zip.file("word/document.xml", xml);
}

const planOf = (db: DB, templateId: number) =>
  normalizePlan(
    (
      db
        .prepare("SELECT output_plan FROM templates WHERE id = ?")
        .get(templateId) as { output_plan: string } | undefined
    )?.output_plan,
  );

/** Expands {template} and {date} in the output's name pattern; adds the extension; avoids two files with the same name. */
function outputFileName(
  o: OutputSpec,
  templateName: string,
  used: Set<string>,
  date: string, // the report date, YYYY-MM-DD
): string {
  const stem = safeName(
    o.name.replace(/\{template\}/gi, templateName).replace(/\{date\}/gi, date),
  ).replace(/\.(docx|xlsx)$/i, "");
  let name = `${stem}.${o.kind}`;
  for (let n = 2; used.has(name.toLowerCase()); n++)
    name = `${stem} (${n}).${o.kind}`;
  used.add(name.toLowerCase());
  return name;
}

function renderDocx(
  file: Buffer,
  data: Record<string, unknown>,
  tableXml: string,
): Buffer {
  const doc = new Docxtemplater(new PizZip(file), {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => "",
  });
  let text = "";
  try {
    text = doc.getFullText();
  } catch {
    /* only used to detect the markers */
  }
  doc.render(data);
  // Old-style templates that draw their own {#items} table must not get a second table appended.
  if (tableXml && !text.includes("{@table}") && !text.includes("{#items}"))
    appendTableAtEnd(doc.getZip(), tableXml);
  return doc
    .getZip()
    .generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

export async function prepare(
  db: DB,
  templateId: number,
  uids: string[],
  title = "",
  refNo = "",
  reportDate = "",
): Promise<Result<ReportPrepared>> {
  pending = null;
  if (!uids.length) return { ok: false, error: "The list is empty" };
  const ref = cleanRef(refNo);
  let repDate = todayIso();
  if (reportDate) {
    const d = parseDate(reportDate);
    if (!d) return { ok: false, error: "The report date is not valid" };
    repDate = d;
  }
  const tpl = getTemplateFile(db, templateId);
  if (!tpl) return { ok: false, error: "Template not found" };
  const plan = planOf(db, templateId);
  if (plan.outputs.some((o) => o.kind === "docx") && !tpl.file)
    return {
      ok: false,
      error: "This template has no Word file yet. Upload one in Templates.",
    };

  const rows = getRowsByUids(db, uids);
  if (!rows.length)
    return { ok: false, error: "None of these transactions exist any more" };
  const total = rows.reduce((n, r) => n + r.amount_paise, 0);
  const items = rows.map((r, i) => ({
    sno: i + 1,
    payee: r.payee,
    bank: r.bank,
    branch: r.branch,
    account_no: r.account_no,
    ifsc: r.ifsc,
    amount: formatPaise(r.amount_paise),
    amount_words: rupeesInWords(r.amount_paise),
    reference_no: r.reference_no,
    date: fmtDate(r.entry_date),
    utr: r.utr,
    notes: r.notes,
  }));
  const texts = Object.fromEntries(
    getTexts(db, templateId).map((t) => [t.key, t.value]),
  );
  const model = buildTableModel(rows, plan, title);
  const base = {
    ...texts,
    ...items[0],
    items,
    count: rows.length,
    total: formatPaise(total),
    total_words: rupeesInWords(total),
    today: fmtDate(repDate),
    ref_no: ref, // the report's own reference ('' when none was entered)
  };

  try {
    const files: PendingFile[] = [];
    const used = new Set<string>();
    for (const o of plan.outputs) {
      const fileName = outputFileName(o, tpl.name, used, repDate);
      let buffer: Buffer;
      if (o.kind === "xlsx") buffer = await buildTableXlsx(model);
      else {
        const tableXml = docxTableXml(model, o.table);
        buffer = renderDocx(tpl.file!, { ...base, table: tableXml }, tableXml);
      }
      files.push({ id: o.id, kind: o.kind, fileName, buffer });
    }
    pending = {
      files,
      templateId,
      templateName: tpl.name,
      uids: rows.map((r) => r.uid),
      total,
      refNo: ref,
      reportDate: repDate,
    };
    return {
      ok: true,
      data: {
        fileName: files[0].fileName,
        files: files.map(({ id, kind, fileName }) => ({ id, kind, fileName })),
        templateName: tpl.name,
        count: rows.length,
        total_paise: total,
      },
    };
  } catch (e) {
    const msg = explain(e);
    return {
      ok: false,
      error:
        "Could not fill the template: " +
        msg +
        (/raw/i.test(msg) ? " (put {@table} alone in its own paragraph)" : ""),
    };
  }
}

export const getPending = () => pending;
export const discard = () => {
  pending = null;
};

/** Called after the file is written. Records the report only when the user kept "save report to database" ticked.
 *  One DB transaction: the report, its items and one reference per transaction (tagged with the report).
 *  Transaction dates are never touched. */
export function record(db: DB, fileName: string) {
  const p = pending;
  if (!p) return;
  db.transaction(() => {
    const now = new Date().toISOString();
    const r = db
      .prepare(
        "INSERT INTO reports (created_at, template_id, template_name, file_name, item_count, total_paise, ref_no, report_date) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        now,
        p.templateId,
        p.templateName,
        fileName,
        p.uids.length,
        p.total,
        p.refNo,
        p.reportDate,
      );
    const reportId = Number(r.lastInsertRowid);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO report_items (report_id, tx_uid) VALUES (?, ?)",
    );
    for (const u of p.uids) {
      ins.run(reportId, u);
      addReference(db, u, p.refNo, { reportId, now });
    }
  })();
}
