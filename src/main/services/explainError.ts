/**
 * Turns a docxtemplater error into plain words. Only the first problem is shown.
 * NOTE: relative import on purpose, so scripts run with plain tsx (no @shared alias needed).
 */
import { WORDS } from "../../shared/words";

export function explain(e: any): string {
  const errs = e?.properties?.errors;
  const first = Array.isArray(errs) && errs.length ? errs[0] : e;
  const p = first?.properties ?? {};
  const W = WORDS.errors;
  const fill = (s: string, a?: string, b?: string) =>
    s.replace("%1", a ?? "").replace("%2", b ?? "");

  switch (p.id) {
    case "unclosed_tag":
      return fill(W.unclosed_tag, p.xtag);
    case "unopened_tag":
      return fill(W.unopened_tag, p.xtag);
    case "raw_xml_tag_should_be_only_text_in_paragraph":
      return fill(W.rawAlone, String(p.xtag ?? "").replace(/^@/, ""));
    case "unclosed_loop":
      return fill(W.loopOpen, p.xtag);
    case "unopened_loop":
      return fill(W.loopClose, p.xtag);
    case "closing_tag_does_not_match_opening_tag":
      return fill(W.loopMismatch, p.openingtag, p.closingtag);
  }
  if (p.id) return W.other;
  return first?.message ?? "Unknown error";
}