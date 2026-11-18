/**
 * Rules for a mapping that arrives from the screen (untrusted input). Pure: no files, no database.
 * validateMapping returns a cleaned copy (only known properties) plus the saved texts the mapping creates.
 * NOTE: relative import on purpose, so scripts run with plain tsx (no @shared alias needed).
 */
import {
  MAP_TAG_LABELS,
  type DocMapping,
  type TemplateText,
} from "../../shared/types";

/** Names the app fills itself. A saved text with one of these keys would never print (the app's value wins). */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(MAP_TAG_LABELS),
  "sno",
  "table",
]);

export const MAX_MAPPINGS = 500;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_TEXT = 2000;

export type MappingCheck =
  | { ok: true; mapping: DocMapping[]; texts: TemplateText[] }
  | { ok: false; error: string };

const bad = (error: string): MappingCheck => ({ ok: false, error });
const isInt = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

export function validateMapping(input: unknown): MappingCheck {
  if (!Array.isArray(input)) return bad("The mapping is not a list");
  if (input.length > MAX_MAPPINGS)
    return bad(`Too many choices (more than ${MAX_MAPPINGS})`);

  const out: DocMapping[] = [];
  const texts = new Map<string, string>();
  let tables = 0;

  for (let i = 0; i < input.length; i++) {
    const m = input[i] as any;
    const at = `Choice ${i + 1}`;
    if (!m || typeof m !== "object") return bad(`${at} is not valid`);
    if (m.kind !== "field" && m.kind !== "text" && m.kind !== "table")
      return bad(`${at} has an unknown kind`);
    const a = m.addr;
    if (
      !a ||
      typeof a.part !== "string" ||
      !/^word\/[\w.-]+\.xml$/.test(a.part) ||
      !Array.isArray(a.path) ||
      a.path.length === 0 ||
      a.path.length > 50 ||
      !a.path.every(isInt)
    )
      return bad(`${at} points at an invalid place in the document`);
    if (typeof m.tag !== "string") return bad(`${at} has no name`);
    const addr = { part: a.part as string, path: [...(a.path as number[])] };

    if (m.kind === "table") {
      if (m.tag !== "@table") return bad(`${at}: a table can only be {@table}`);
      if (++tables > 1) return bad("Only one table can be replaced");
      out.push({ kind: "table", addr, tag: "@table" });
      continue;
    }

    if (
      !isInt(m.start) ||
      !isInt(m.end) ||
      m.end <= m.start ||
      typeof m.text !== "string" ||
      m.text.length !== m.end - m.start
    )
      return bad(`${at} has an invalid text selection`);

    if (m.kind === "field") {
      if (!Object.hasOwn(MAP_TAG_LABELS, m.tag))
        return bad(`${at}: "${m.tag}" is not a field the app can fill`);
    } else {
      if (!KEY_RE.test(m.tag))
        return bad(
          `${at}: saved-text name "${m.tag}" must use lowercase letters, digits and _ (start with a letter)`,
        );
      if (RESERVED_KEYS.has(m.tag))
        return bad(
          `${at}: "${m.tag}" is a name the app fills itself, so pick another name for this saved text`,
        );
      if (m.text.length > MAX_TEXT)
        return bad(`${at}: saved text is longer than ${MAX_TEXT} characters`);
      const seen = texts.get(m.tag);
      if (seen !== undefined && seen !== m.text)
        return bad(
          `The saved-text name "${m.tag}" is used for two different texts`,
        );
      texts.set(m.tag, m.text);
    }
    out.push({
      kind: m.kind,
      addr,
      start: m.start,
      end: m.end,
      text: m.text,
      tag: m.tag,
    });
  }
  return {
    ok: true,
    mapping: out,
    texts: [...texts].map(([key, value]) => ({ key, value })),
  };
}
