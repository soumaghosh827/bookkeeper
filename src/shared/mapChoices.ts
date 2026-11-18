/**
 * Turns the choices made on the mapping screen into the DocMapping list that testFill and saveMapped take.
 * Pure: no files, no database. Relative import on purpose, so scripts run with plain tsx (no @shared alias needed).
 */
import type { DocAddr, DocMapping, DocSuggestion } from "./types";

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

const sameAddr = (a: DocAddr, b: DocAddr) =>
  a.part === b.part &&
  a.path.length === b.path.length &&
  a.path.every((v, i) => v === b.path[i]);

/**
 * The reverse of buildMapping: finds, for each saved choice, the suggestion it was made on (same place and same covered text)
 * and turns it back into a pick. Choices that match no suggestion are counted in `dropped` and left out.
 * A field choice may sit on a text suggestion and the reverse, so only the position is compared, not the kind.
 */
export function picksFromMapping(
  suggestions: readonly DocSuggestion[],
  mapping: readonly DocMapping[],
): {
  picks: Record<string, { kind: DocMapping["kind"]; tag: string }>;
  dropped: number;
} {
  const picks: Record<string, { kind: DocMapping["kind"]; tag: string }> = {};
  let dropped = 0;
  for (const m of mapping) {
    const s = suggestions.find((x) => {
      if (picks[x.id] || !sameAddr(x.addr, m.addr)) return false;
      if (m.kind === "table") return x.kind === "table";
      return (
        x.kind !== "table" &&
        x.start === m.start &&
        x.end === m.end &&
        (m.text === undefined || m.text === x.text)
      );
    });
    if (!s) {
      dropped++;
      continue;
    }
    picks[s.id] =
      m.kind === "table"
        ? { kind: "table", tag: "@table" }
        : { kind: m.kind, tag: m.tag };
  }
  return { picks, dropped };
}
