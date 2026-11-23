import {
  DEFAULT_FILE_NAME,
  type OutputPlan,
  type OutputSpec,
  type TablePlacement,
} from "./types";
import { todayIso } from "./format";
import { WORDS } from "./words";

export type PresetId = "one_page" | "two_page" | "letter_excel";

/** The options of the layout selector in the Templates tab, in display order. */
export const PRESETS: readonly { id: PresetId; label: string; hint: string }[] =
  [
    { id: "one_page", ...WORDS.layout.one_page },
    { id: "two_page", ...WORDS.layout.two_page },
    { id: "letter_excel", ...WORDS.layout.letter_excel },
  ];

/** The layout nearest to a plan's outputs. Nothing extra is stored: the outputs themselves decide. Always returns a real layout. */
export function detectPreset(plan: OutputPlan): PresetId {
  if (plan.outputs.some((s) => s.kind === "xlsx")) return "letter_excel";
  const d = plan.outputs.find((s) => s.kind === "docx");
  return d?.table === "new_page" ? "two_page" : "one_page";
}

/** Plan with the outputs of a preset. Columns and total label are kept, and so are existing file name patterns. */
export function applyPreset(plan: OutputPlan, id: PresetId): OutputPlan {
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

/** A finished letter decides where its table goes, so a forced new page becomes the {@table} position. Nothing else changes. */
export function lockInline(plan: OutputPlan): OutputPlan {
  if (!plan.outputs.some((o) => o.kind === "docx" && o.table === "new_page"))
    return plan;
  return {
    ...plan,
    outputs: plan.outputs.map((o) =>
      o.kind === "docx" && o.table === "new_page"
        ? { ...o, table: "inline" as const }
        : o,
    ),
  };
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

const WORD_NOTE: Record<TablePlacement, string> = WORDS.note.word;
const MAPPED_NOTE: Record<TablePlacement, string> = WORDS.note.mappedWord;
const MAPPED_LABEL: Record<PresetId, string> = WORDS.layout.mapped.label;

/** Layout choices for the selector. A finished letter fixes its own table position, so it only offers letter-only or letter + Excel. */
export function layoutOptions(mapped: boolean) {
  return mapped
    ? PRESETS.filter((p) => p.id !== "two_page").map((p) => ({
        id: p.id,
        label: MAPPED_LABEL[p.id],
      }))
    : PRESETS.map((p) => ({ id: p.id, label: p.label }));
}

/** Everything a preview needs to say what a template will generate. */
export function summarizePlan(
  plan: OutputPlan,
  templateName: string,
  mapped = false,
): PlanSummary {
  const preset = detectPreset(plan);
  const used = new Set<string>();
  const outputs = plan.outputs.map((o) => ({
    id: o.id,
    kind: o.kind,
    fileName: expandFileName(o, templateName, used),
    note:
      o.kind === "xlsx"
        ? WORDS.note.excel
        : (mapped ? MAPPED_NOTE : WORD_NOTE)[o.table],
  }));
  const headers = plan.columns.filter((c) => c.on).map((c) => c.header);
  const kinds = [
    plan.outputs.some((o) => o.kind === "docx") ? "Word" : "",
    plan.outputs.some((o) => o.kind === "xlsx") ? "Excel" : "",
  ].filter(Boolean);
  return {
    preset,
    presetLabel: mapped
      ? MAPPED_LABEL[preset]
      : PRESETS.find((p) => p.id === preset)!.label,
    outputs,
    headers,
    totalLabel: plan.totalLabel,
    oneLine: `${kinds.join(" + ")} · ${headers.length} columns`,
  };
}
