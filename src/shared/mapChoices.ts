/**
 * Turns the choices made on the mapping screen into the DocMapping list that testFill and saveMapped take.
 * Pure: no files, no database. Relative import on purpose, so scripts run with plain tsx (no @shared alias needed).
 */
import type { DocMapping, DocSuggestion } from "./types";

/**
 * One DocMapping per chosen suggestion, in document order (the order of `suggestions`).
 * `picks` maps a suggestion id to what the user chose for it; a suggestion with no entry is Keep and is left out.
 * The covered text and offsets always come from the suggestion, so they match the file exactly.
 */
export function buildMapping(
  suggestions: readonly DocSuggestion[],
  picks: Readonly<Record<string, { kind: DocMapping["kind"]; tag: string }>>,
): DocMapping[] {
  const out: DocMapping[] = [];
  for (const s of suggestions) {
    const p = picks[s.id];
    if (!p) continue;
    const addr = { part: s.addr.part, path: [...s.addr.path] };
    if (s.kind === "table") {
      out.push({ kind: "table", addr, tag: "@table" });
    } else if (
      p.kind !== "table" &&
      s.start !== undefined &&
      s.end !== undefined
    ) {
      out.push({
        kind: p.kind,
        addr,
        start: s.start,
        end: s.end,
        text: s.text,
        tag: p.tag,
      });
    }
  }
  return out;
}
