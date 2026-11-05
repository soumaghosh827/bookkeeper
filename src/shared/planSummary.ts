import {
  DEFAULT_FILE_NAME,
  type OutputPlan,
  type OutputSpec,
  type TablePlacement,
} from "./types";
import { todayIso } from "./format";

export type PresetId = "one_page" | "two_page" | "letter_excel" | "custom";

/** The options of the layout selector in the Templates tab, in display order. */
export const PRESETS: readonly { id: PresetId; label: string; hint: string }[] =
  [
    {
      id: "one_page",
      label: "One-page Word file with table",
      hint: "Letter and table in one Word file. The table sits where {@table} is in the Word file.",
    },
    {
      id: "two_page",
      label: "Two-page Word file",
      hint: "Letter on page 1, table starts on page 2.",
    },
    {
      id: "letter_excel",
      label: "Word letter + separate Excel table",
      hint: "Two files: the letter without a table, and the table as an Excel file.",
    },
    {
      id: "custom",
      label: "Custom",
      hint: "Choose the outputs yourself.",
    },
  ];

/** Which preset a plan matches. Nothing extra is stored: the outputs themselves decide. Anything else is 'custom'. */
export function detectPreset(plan: OutputPlan): PresetId {
  const o = plan.outputs;
  if (o.length === 1 && o[0].kind === "docx") {
    if (o[0].table === "inline") return "one_page";
    if (o[0].table === "new_page") return "two_page";
  }
  if (o.length === 2) {
    const d = o.find((s) => s.kind === "docx");
    const e = o.find((s) => s.kind === "xlsx");
    if (d && e && d.table === "none") return "letter_excel";
  }
  return "custom";
}

/** Plan with the outputs of a preset. Columns and total label are kept, and so are existing file name patterns. 'custom' changes nothing. */
export function applyPreset(plan: OutputPlan, id: PresetId): OutputPlan {
  if (id === "custom") return plan;
  const nameOf = (kind: OutputSpec["kind"]) =>
    plan.outputs.find((o) => o.kind === kind)?.name ?? DEFAULT_FILE_NAME;
  const docx = (table: TablePlacement): OutputSpec => ({
    id: "o1",
    kind: "docx",
    name: nameOf("docx"),
    table,
  });
  const xlsx: OutputSpec = {
    id: "o2",
    kind: "xlsx",
    name: nameOf("xlsx"),
    table: "inline",
  };
  const outputs =
    id === "one_page"
      ? [docx("inline")]
      : id === "two_page"
        ? [docx("new_page")]
        : [docx("none"), xlsx];
  return { ...plan, outputs };
}

const safe = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim()
    .slice(0, 80) || "Report";

/** Same rule the report generator uses: {template} and {date} expanded, extension added, no two files with the same name. */
export function expandFileName(
  o: OutputSpec,
  templateName: string,
  used: Set<string>,
  date = todayIso(),
): string {
  const stem = safe(
    o.name.replace(/\{template\}/gi, templateName).replace(/\{date\}/gi, date),
  ).replace(/\.(docx|xlsx)$/i, "");
  let name = `${stem}.${o.kind}`;
  for (let n = 2; used.has(name.toLowerCase()); n++)
    name = `${stem} (${n}).${o.kind}`;
  used.add(name.toLowerCase());
  return name;
}

export interface PlanSummary {
  preset: PresetId;
  presetLabel: string;
  outputs: {
    id: string;
    kind: "docx" | "xlsx";
    fileName: string;
    note: string;
  }[];
  headers: string[]; // switched-on columns, in table order
  totalLabel: string;
  oneLine: string; // e.g. "Word letter + Excel table · 7 columns"
}

const WORD_NOTE: Record<TablePlacement, string> = {
  inline:
    "Table at the {@table} marker (at the end of the letter if the Word file has none)",
  new_page: "Table starts on a new page",
  none: "Letter only, no table",
};

/** Everything a preview needs to say what a template will generate. */
export function summarizePlan(
  plan: OutputPlan,
  templateName: string,
): PlanSummary {
  const preset = detectPreset(plan);
  const used = new Set<string>();
  const outputs = plan.outputs.map((o) => ({
    id: o.id,
    kind: o.kind,
    fileName: expandFileName(o, templateName, used),
    note:
      o.kind === "xlsx"
        ? "Table only. Row 1 blank, optional title in row 2, then the table"
        : WORD_NOTE[o.table],
  }));
  const headers = plan.columns.filter((c) => c.on).map((c) => c.header);
  const kinds = [
    plan.outputs.some((o) => o.kind === "docx") ? "Word" : "",
    plan.outputs.some((o) => o.kind === "xlsx") ? "Excel" : "",
  ].filter(Boolean);
  return {
    preset,
    presetLabel: PRESETS.find((p) => p.id === preset)!.label,
    outputs,
    headers,
    totalLabel: plan.totalLabel,
    oneLine: `${kinds.join(" + ")} · ${headers.length} columns`,
  };
}
