import type {
  DocBlock,
  DocCell,
  DocModel,
  DocParagraph,
  DocTable,
  OutputPlan,
  TablePlacement,
} from "./types";
import { tableHeader } from "./format";

// Preview only: rough column widths, like the real table's.
const W: Record<string, number> = {
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

function para(
  part: string,
  text: string,
  o: {
    align?: DocParagraph["align"];
    bold?: boolean;
    pageBreakBefore?: boolean;
  } = {},
): DocParagraph {
  return {
    type: "p",
    addr: { part, path: [-1] },
    align: o.align ?? "left",
    pageBreakBefore: o.pageBreakBefore,
    runs: text ? [{ text, bold: o.bold, size: 9, run: 0, offset: 0 }] : [],
  };
}

function cell(
  part: string,
  text: string,
  o: {
    align?: DocParagraph["align"];
    bold?: boolean;
    span?: number;
    shade?: string;
  } = {},
): DocCell {
  return {
    span: o.span ?? 1,
    shade: o.shade,
    blocks: [para(part, text, { align: o.align, bold: o.bold })],
  };
}

/** A sample of the report table: the template's headers, two dummy rows and the total row. */
function sampleTable(part: string, plan: OutputPlan): DocTable | null {
  const cols = plan.columns.filter((c) => c.on);
  if (!cols.length) return null;
  const sum = cols.reduce((n, c) => n + (W[c.key] ?? 12), 0);
  const ai = cols.findIndex((c) => c.key === "amount");
  const rows: DocTable["rows"] = [
    {
      cells: cols.map((c) =>
        cell(part, tableHeader(c.key, c.header), {
          bold: true,
          align: "center",
          shade: "D9D9D9",
        }),
      ),
    },
    ...[0, 1].map(() => ({
      cells: cols.map((c) =>
        cell(part, "…", { align: c.key === "amount" ? "right" : "left" }),
      ),
    })),
  ];
  if (ai >= 0) {
    const total: DocCell[] = [];
    if (ai > 0)
      total.push(
        cell(part, plan.totalLabel, { span: ai, bold: true, align: "right" }),
      );
    total.push(cell(part, "0.00", { bold: true, align: "right" }));
    if (ai < cols.length - 1)
      total.push(cell(part, "", { span: cols.length - 1 - ai }));
    rows.push({ cells: total });
  }
  return {
    type: "table",
    addr: { part, path: [-1] },
    colWidths: cols.map((c) => (W[c.key] ?? 12) / sum),
    rows,
  };
}

const isMarker = (b: DocBlock) =>
  b.type === "p" &&
  b.runs
    .map((r) => r.text)
    .join("")
    .trim() === "{@table}";

/** The Word placement of a plan: what its first Word output does with the table. */
export function wordPlacement(plan: OutputPlan): TablePlacement | null {
  return plan.outputs.find((o) => o.kind === "docx")?.table ?? null;
}

/**
 * A copy of the letter's model with the table shown where the layout puts it:
 * at the {@table} marker (or the end of the letter if there is none), after a page break,
 * or not at all. The input model is not changed.
 */
export function withLayout(
  model: DocModel,
  plan: OutputPlan,
  placement: TablePlacement,
): DocModel {
  const body = model.parts.find((p) => p.kind === "body");
  if (!body) return model;
  const table = placement === "none" ? null : sampleTable(body.part, plan);
  const add: DocBlock[] = table
    ? [
        ...(placement === "new_page"
          ? [para(body.part, "", { pageBreakBefore: true })]
          : []),
        table,
      ]
    : [];
  const at = body.blocks.findIndex(isMarker);
  const blocks =
    at >= 0
      ? [...body.blocks.slice(0, at), ...add, ...body.blocks.slice(at + 1)]
      : [...body.blocks, ...add];
  return {
    ...model,
    parts: model.parts.map((p) => (p === body ? { ...p, blocks } : p)),
  };
}
