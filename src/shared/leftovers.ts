/**
 * Advice only: finds values the user turned into fields that still appear, as typed, somewhere else in the letter.
 * Pure: no files, no database. Relative import on purpose, so scripts run with plain tsx.
 * Spelled-out forms (for example an account number written in words) are NOT checked.
 */
import { MAP_TAG_LABELS } from "./types";
import type { DocAddr, DocBlock, DocModel, DocSuggestion } from "./types";

// Fields that describe the payee. Amounts and dates are left out on purpose: they often appear again legitimately.
export const LEFTOVER_FIELDS = new Set([
  "payee",
  "bank",
  "branch",
  "account_no",
  "ifsc",
  "utr",
  "reference_no",
]);
export const LEFTOVER_MIN_LENGTH = 4;

export interface Leftover {
  value: string; // the original text the user chose to replace
  tag: string;
  label: string; // friendly field name
  count: number; // how many other places still hold it
  sample: string; // the start of the first paragraph that holds it
}

const keyOf = (a: DocAddr) => a.part + "|" + a.path.join(".");

export function findLeftovers(
  model: DocModel,
  suggestions: readonly DocSuggestion[],
  picks: Readonly<Record<string, { kind: string; tag: string }>>,
): Leftover[] {
  const ranges = new Map<string, [number, number][]>(); // chosen text, per paragraph
  const tables = new Set<string>(); // tables that will be replaced
  const values = new Map<string, { value: string; tag: string }>(); // lowercase value -> original

  for (const s of suggestions) {
    const p = picks[s.id];
    if (!p) continue;
    if (s.kind === "table") {
      tables.add(keyOf(s.addr));
      continue;
    }
    if (s.start === undefined || s.end === undefined) continue;
    const k = keyOf(s.addr);
    const list = ranges.get(k) ?? [];
    list.push([s.start, s.end]);
    ranges.set(k, list);
    const v = s.text.trim();
    if (
      p.kind === "field" &&
      LEFTOVER_FIELDS.has(p.tag) &&
      v.length >= LEFTOVER_MIN_LENGTH &&
      !values.has(v.toLowerCase())
    )
      values.set(v.toLowerCase(), { value: v, tag: p.tag });
  }
  if (!values.size) return [];

  const hits = new Map<string, { count: number; sample: string }>();
  const visit = (blocks: readonly DocBlock[]) => {
    for (const b of blocks) {
      if (b.type === "table") {
        if (tables.has(keyOf(b.addr))) continue; // the whole table is replaced
        for (const row of b.rows)
          for (const cell of row.cells) visit(cell.blocks);
        continue;
      }
      const text = b.runs.map((r) => r.text).join("");
      if (!text) continue;
      const low = text.toLowerCase();
      const mine = ranges.get(keyOf(b.addr)) ?? [];
      for (const lv of values.keys()) {
        let from = 0;
        for (;;) {
          const i = low.indexOf(lv, from);
          if (i < 0) break;
          from = i + lv.length;
          if (mine.some(([a, z]) => i < z && i + lv.length > a)) continue; // that is the chosen text itself
          const h = hits.get(lv) ?? {
            count: 0,
            sample: text.trim().slice(0, 80),
          };
          h.count++;
          hits.set(lv, h);
        }
      }
    }
  };
  for (const part of model.parts) visit(part.blocks);

  const out: Leftover[] = [];
  for (const [k, v] of values) {
    const h = hits.get(k);
    if (h)
      out.push({
        ...v,
        label: MAP_TAG_LABELS[v.tag] ?? v.tag,
        count: h.count,
        sample: h.sample,
      });
  }
  return out;
}
