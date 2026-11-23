import PizZip from "pizzip";
import { XMLSerializer } from "@xmldom/xmldom";
import type { DocMapping } from "@shared/types";
import {
  collectRuns,
  elementChildren,
  kid,
  loadStyles,
  parseXml,
} from "./docxModel";
import { rPrElement, tableLookOf } from "./docxFont";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PART_RE = /^word\/(document|header\d*|footer\d*)\.xml$/;
const TAG_RE = /^[a-z][a-z0-9_]{0,39}$/;
// Wrappers that may be left empty after their runs are removed. (sdt is kept: it has its own properties.)
const EMPTY_WRAPPERS = new Set([
  "hyperlink",
  "ins",
  "smartTag",
  "fldSimple",
  "customXml",
]);

/** One piece of visible text inside a run: a <w:t>, or a one-character <w:tab>/<w:br>/<w:cr>/<w:noBreakHyphen>. */
interface Unit {
  el: Element;
  run: Element;
  start: number;
  end: number;
  isText: boolean;
}

/** Walks a paragraph exactly the way docxModel.readParagraph counts its text. */
function unitsOf(p: Element): { units: Unit[]; text: string } {
  const units: Unit[] = [];
  let text = "";
  for (const run of collectRuns(p)) {
    for (const c of elementChildren(run)) {
      let piece: string;
      let isText = false;
      switch (c.localName) {
        case "t":
          piece = c.textContent ?? "";
          isText = true;
          break;
        case "tab":
          piece = "\t";
          break;
        case "br":
        case "cr":
          piece = "\n";
          break;
        case "noBreakHyphen":
          piece = "-";
          break;
        default:
          continue;
      }
      if (!piece.length) continue;
      units.push({
        el: c,
        run,
        start: text.length,
        end: text.length + piece.length,
        isText,
      });
      text += piece;
    }
  }
  return { units, text };
}

/** Follows addr.path using the same elementChildren indexing as docxModel (pPr, tblPr, sectPr all count). */
function locate(root: Element, path: number[]): Element {
  let el = root;
  for (const i of path) {
    const c = elementChildren(el)[i];
    if (!c)
      throw new Error(
        "The Word file no longer matches this mapping (an item was not found).",
      );
    el = c;
  }
  return el;
}

function setText(doc: Document, el: Element, text: string) {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(doc.createTextNode(text)); // escaping (&, <, >) happens when the XML is serialised
  el.setAttribute("xml:space", "preserve");
}

function makeT(doc: Document, text: string): Element {
  const t = doc.createElementNS(W, "w:t");
  setText(doc, t, text);
  return t;
}

/** Puts {tag} into the first covered text and removes the rest of the covered text. */
function editRange(
  doc: Document,
  units: Unit[],
  s: number,
  e: number,
  tag: string,
  touched: Set<Element>,
) {
  const hit = units.filter((u) => u.end > s && u.start < e);
  if (!hit.length)
    throw new Error("A mapped selection is empty or outside the paragraph.");
  hit.forEach((u, i) => {
    const first = i === 0;
    const a = Math.max(s, u.start) - u.start;
    const b = Math.min(e, u.end) - u.start;
    touched.add(u.run);
    if (u.isText) {
      const t = u.el.textContent ?? "";
      const next = t.slice(0, a) + (first ? tag : "") + t.slice(b);
      if (next === "") u.el.parentNode!.removeChild(u.el);
      else setText(doc, u.el, next);
    } else if (first) {
      u.el.parentNode!.replaceChild(makeT(doc, tag), u.el);
    } else {
      u.el.parentNode!.removeChild(u.el);
    }
  });
}

function dropEmptyRuns(touched: Set<Element>) {
  for (const run of touched) {
    if (elementChildren(run).some((c) => c.localName !== "rPr")) continue; // still holds text, a picture, a field mark...
    let parent = run.parentNode as Element | null;
    parent?.removeChild(run);
    while (
      parent &&
      EMPTY_WRAPPERS.has(parent.localName) &&
      elementChildren(parent).length === 0
    ) {
      const up = parent.parentNode as Element | null;
      up?.removeChild(parent);
      parent = up;
    }
  }
}

function rewriteParagraph(doc: Document, p: Element, list: DocMapping[]) {
  const { units, text } = unitsOf(p);
  const ms = [...list].sort((x, y) => (x.start ?? 0) - (y.start ?? 0));
  let prevEnd = 0;
  let rest = "";
  for (const m of ms) {
    const s = m.start;
    const e = m.end;
    if (
      !Number.isInteger(s) ||
      !Number.isInteger(e) ||
      s! < 0 ||
      e! <= s! ||
      e! > text.length
    )
      throw new Error(
        "A mapped selection is outside its paragraph. Re-select it.",
      );
    if (s! < prevEnd)
      throw new Error("Two selections overlap in the same paragraph.");
    if (m.text !== undefined && text.slice(s, e) !== m.text)
      throw new Error(
        `The text "${m.text}" is no longer where it was mapped, so the mapping can't be applied. Re-select it.`,
      );
    rest += text.slice(prevEnd, s);
    prevEnd = e!;
  }
  rest += text.slice(prevEnd);
  if (/[{}]/.test(rest))
    throw new Error(
      `This paragraph already contains a "{" or "}" character ("${text.slice(0, 40)}"). Word templates read these as tags: remove them, or include them in the selection.`,
    );
  const touched = new Set<Element>();
  // Last to first: editing later text never shifts the offsets of earlier selections.
  for (const m of [...ms].reverse())
    editRange(doc, units, m.start!, m.end!, `{${m.tag}}`, touched);
  dropEmptyRuns(touched);
}

/**
 * Rewrites the user's Word file: every mapping becomes a {tag} in the first covered run (keeping its formatting),
 * the rest of the covered text is removed, and a mapped table becomes a paragraph holding {@table}.
 * Throws an Error with a plain-English message when a mapping can't be applied.
 */
export function applyMapping(
  source: Uint8Array,
  mappings: DocMapping[],
): Buffer {
  let zip: PizZip;
  try {
    zip = new PizZip(source);
  } catch {
    throw new Error("This file is not a valid .docx");
  }
  const byPart = new Map<string, DocMapping[]>();
  for (const m of mappings) {
    if (!PART_RE.test(m.addr.part))
      throw new Error(
        "A mapping points outside the document, headers or footers.",
      );
    const ok = m.kind === "table" ? m.tag === "@table" : TAG_RE.test(m.tag);
    if (!ok) throw new Error(`"${m.tag}" is not a valid field name.`);
    (
      byPart.get(m.addr.part) ?? byPart.set(m.addr.part, []).get(m.addr.part)!
    ).push(m);
  }

  const st = loadStyles(zip);
  for (const [part, list] of byPart) {
    const xml = zip.file(part)?.asText();
    if (!xml)
      throw new Error(
        "The Word file no longer matches this mapping (a part is missing).",
      );
    const doc = parseXml(xml);
    const top = doc.documentElement as Element;
    const root = part === "word/document.xml" ? kid(top, "body") : top;
    if (!root) throw new Error("This file is not a valid .docx");

    // Resolve everything first, so a bad mapping fails before anything is changed.
    const tables = list
      .filter((m) => m.kind === "table")
      .map((m) => ({ m, el: locate(root, m.addr.path) }));
    for (const t of tables)
      if (t.el.localName !== "tbl")
        throw new Error("A table mapping does not point at a table.");
    const paras = new Map<Element, DocMapping[]>();
    for (const m of list.filter((x) => x.kind !== "table")) {
      const el = locate(root, m.addr.path);
      if (el.localName !== "p")
        throw new Error("A mapping does not point at a paragraph.");
      if (
        tables.some((t) => t.m.addr.path.every((v, i) => m.addr.path[i] === v))
      )
        throw new Error(
          "A selection sits inside a table that is being replaced.",
        );
      (paras.get(el) ?? paras.set(el, []).get(el)!).push(m);
    }
    if (new Set(tables.map((t) => t.el)).size !== tables.length)
      throw new Error("The same table is mapped twice.");

    for (const [p, ms] of paras) rewriteParagraph(doc, p, ms);
    for (const { el } of tables) {
      const look = tableLookOf(el, st);
      const p = doc.createElementNS(W, "w:p");
      const r = doc.createElementNS(W, "w:r");
      if (look) {
        r.appendChild(rPrElement(doc, look.body, true));
        const pPr = doc.createElementNS(W, "w:pPr");
        pPr.appendChild(rPrElement(doc, look.head));
        p.appendChild(pPr);
      }
      r.appendChild(makeT(doc, "{@table}"));
      p.appendChild(r);
      el.parentNode!.replaceChild(p, el);
    }

    const out = new XMLSerializer().serializeToString(doc as any);
    const decl = xml.match(/^\s*<\?xml[^>]*\?>\s*/)?.[0] ?? "";
    zip.file(part, out.startsWith("<?xml") ? out : decl + out);
  }
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}
