import PizZip from "pizzip";
import {
  collectRuns,
  effectiveRunProps,
  loadStyles,
  parseXml,
  attr,
  elementChildren,
  kid,
  type Styles,
} from "./docxModel";

/** Used only when no font can be found anywhere in the Word file. */
export const FALLBACK_FONT = "Calibri";

export interface TableFont {
  family: string;
  /** Ready-to-insert <w:rFonts/> element for the table's text. */
  fonts: string;
  /** Full run properties copied from the template's original table. Set only when it had one. */
  head?: string;
  body?: string;
  total?: string;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// ascii + hAnsi only: Hindi/Bengali text keeps whatever complex-script font the letter already uses
const rFontsXml = (name: string) =>
  `<w:rFonts w:ascii="${esc(name)}" w:hAnsi="${esc(name)}"/>`;

const textOf = (el: Element) =>
  Array.from(el.getElementsByTagName("w:t"))
    .map((t) => t.textContent ?? "")
    .join("");

/**
 * Font for the generated table: the real font of the last paragraph that has text before the {@table} marker
 * (before the end of the letter when there is no marker). Never throws: any problem gives the fallback.
 */
function lastParagraphFont(file: Uint8Array): TableFont {
  const make = (family: string): TableFont => ({
    family,
    fonts: rFontsXml(family),
  });
  try {
    const zip = new PizZip(file);
    const xml = zip.file("word/document.xml")?.asText();
    if (!xml) return make(FALLBACK_FONT);
    const st = loadStyles(zip);
    const BODY_MIN_CHARS = 80; // shorter paragraphs (signatory, "Yours faithfully", subject lines) are not body text
    const inBox = (p: Element) => {
      for (let n = p.parentNode; n; n = n.parentNode)
        if (["tbl", "txbxContent"].includes((n as Element).localName))
          return true;
      return false;
    };
    // the font of the run that carries most of a paragraph's text
    const fontOf = (p: Element) => {
      let best: Element | undefined;
      let len = 0;
      for (const r of collectRuns(p)) {
        const n = textOf(r).trim().length;
        if (n > len) {
          best = r;
          len = n;
        }
      }
      return best ? effectiveRunProps(p, best, st).font : undefined;
    };

    const paras = Array.from(parseXml(xml).getElementsByTagName("w:p"));
    const at = paras.findIndex((p) => textOf(p).includes("{@table}"));
    const before = (at >= 0 ? paras.slice(0, at) : paras).filter(
      (p) => !inBox(p),
    );

    // 1. the last real body paragraph
    for (let i = before.length - 1; i >= 0; i--) {
      if (textOf(before[i]).trim().length < BODY_MIN_CHARS) continue;
      const f = fontOf(before[i]);
      if (f) return make(f);
    }
    // 2. otherwise the font that carries most of the letter's text
    const weight = new Map<string, number>();
    for (const p of before) {
      const f = fontOf(p);
      if (f) weight.set(f, (weight.get(f) ?? 0) + textOf(p).trim().length);
    }
    const top = [...weight.entries()].sort((a, b) => b[1] - a[1])[0];
    return make(top?.[0] ?? st.defR.font ?? FALLBACK_FONT);
  } catch {
    return make(FALLBACK_FONT);
  }
}

// ---- the font details of a table that was already in the uploaded Word file ----

/** Put on the {@table} marker run when the original table's details are saved there (step 6 writes it, step 7 reads it). */
export const STAMP_STYLE = "BKTableFont";

export interface FontProps {
  font?: string;
  size?: number; // pt
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

type Part = [string, Record<string, string>];

// order follows Word's schema: rStyle, rFonts, b, bCs, i, iCs, color, sz, szCs, u
function parts(p: FontProps, stamp: boolean): Part[] {
  const out: Part[] = [];
  if (stamp) out.push(["rStyle", { val: STAMP_STYLE }]);
  if (p.font) out.push(["rFonts", { ascii: p.font, hAnsi: p.font }]);
  if (p.bold) out.push(["b", {}], ["bCs", {}]);
  if (p.italic) out.push(["i", {}], ["iCs", {}]);
  if (p.color) out.push(["color", { val: p.color }]);
  if (p.size) {
    const v = String(Math.round(p.size * 2));
    out.push(["sz", { val: v }], ["szCs", { val: v }]);
  }
  if (p.underline) out.push(["u", { val: "single" }]);
  return out;
}

/** The properties as the inside of a <w:rPr>, ready to put in generated XML. */
export function rPrXml(p: FontProps, stamp = false): string {
  return parts(p, stamp)
    .map(
      ([n, a]) =>
        `<w:${n}${Object.entries(a)
          .map(([k, v]) => ` w:${k}="${esc(v)}"`)
          .join("")}/>`,
    )
    .join("");
}

/** The same as a <w:rPr> element, for the rewrite engine (docxMap). */
export function rPrElement(
  doc: Document,
  p: FontProps,
  stamp = false,
): Element {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const rPr = doc.createElementNS(W, "w:rPr");
  for (const [n, a] of parts(p, stamp)) {
    const e = doc.createElementNS(W, "w:" + n);
    for (const [k, v] of Object.entries(a)) e.setAttribute("w:" + k, v);
    rPr.appendChild(e);
  }
  return rPr;
}

export interface TableLook {
  head: FontProps;
  body: FontProps;
}

/**
 * Font details of an existing Word table, as Word really shows them (styles and defaults applied).
 * Header = the first row with text, body = the row after it (the header's details without bold when there is none).
 * Null when the table has no text at all.
 */
export function tableLookOf(tbl: Element, st: Styles): TableLook | null {
  const rows = elementChildren(tbl).filter((c) => c.localName === "tr");
  const read = (tr: Element | undefined): FontProps | null => {
    if (!tr) return null;
    for (const tc of elementChildren(tr).filter((c) => c.localName === "tc"))
      for (const p of elementChildren(tc).filter((c) => c.localName === "p")) {
        const run = collectRuns(p).find((r) => textOf(r).trim() !== "");
        if (run) return effectiveRunProps(p, run, st);
      }
    return null;
  };
  const head = read(rows[0]);
  if (!head) return null;
  return { head, body: read(rows[1]) ?? { ...head, bold: false } };
}

// ---- reading the details saved on the {@table} marker (written by applyMapping) ----

const isOn = (e: Element | null) =>
  !!e && !["0", "false", "off"].includes(attr(e, "val") ?? "");

function readProps(rPr: Element | null): FontProps {
  if (!rPr) return {};
  const sz = attr(kid(rPr, "sz"), "val");
  return {
    font: attr(kid(rPr, "rFonts"), "ascii"),
    size: sz ? Number(sz) / 2 : undefined,
    color: attr(kid(rPr, "color"), "val"),
    bold: isOn(kid(rPr, "b")),
    italic: isOn(kid(rPr, "i")),
    underline: !!kid(rPr, "u"),
  };
}

/**
 * Font for the generated table.
 *  - The template's original table was mapped: its saved header/body details (font, size, colour, bold, italic, underline).
 *  - Otherwise: the font of the last paragraph with text before {@table} (Calibri when nothing can be read).
 * Never throws.
 */
export function tableFontFor(file: Uint8Array): TableFont {
  const base = lastParagraphFont(file);
  try {
    const xml = new PizZip(file).file("word/document.xml")?.asText();
    if (!xml) return base;
    const marker = Array.from(parseXml(xml).getElementsByTagName("w:p")).find(
      (p) => textOf(p).includes("{@table}"),
    );
    if (!marker) return base;
    const run = collectRuns(marker).find(
      (r) => attr(kid(kid(r, "rPr"), "rStyle"), "val") === STAMP_STYLE,
    );
    if (!run) return base;
    const body = readProps(kid(run, "rPr"));
    const head = readProps(kid(kid(marker, "pPr"), "rPr"));
    // anything the saved details lack falls back to the last-paragraph font and the usual 9 pt
    const fill = (p: FontProps): FontProps => ({
      ...p,
      font: p.font ?? base.family,
      size: p.size ?? 9,
    });
    const family = body.font ?? base.family;
    return {
      family,
      fonts: rFontsXml(family),
      head: rPrXml(fill(head)),
      body: rPrXml(fill(body)),
      total: rPrXml({ ...fill(body), bold: true }),
    };
  } catch {
    return base;
  }
}
