import PizZip from "pizzip";
import { DOMParser } from "@xmldom/xmldom";
import type {
  DocAddr,
  DocBlock,
  DocCell,
  DocModel,
  DocPart,
  DocParagraph,
  DocRun,
  DocTable,
} from "@shared/types";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// ---- XML helpers (exported: step 7's rewrite engine reuses them) ----
export const parseXml = (xml: string): Document =>
  new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;

export function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}
export const kids = (el: Element, name: string): Element[] =>
  elementChildren(el).filter((c) => c.localName === name);
export const kid = (
  el: Element | null | undefined,
  name: string,
): Element | null =>
  el ? (elementChildren(el).find((c) => c.localName === name) ?? null) : null;
export const attr = (
  el: Element | null | undefined,
  name: string,
): string | undefined => {
  if (!el) return undefined;
  return (
    el.getAttributeNS(W, name) || el.getAttribute("w:" + name) || undefined
  );
};
// <w:b/> = on, <w:b w:val="0"/> = off, absent = undefined (inherit)
const flag = (el: Element | null): boolean | undefined => {
  if (!el) return undefined;
  const v = attr(el, "val");
  return !(v === "0" || v === "false" || v === "off");
};

// ---- properties ----
interface RProps {
  font?: string;
  size?: number; // pt
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}
interface PProps {
  align?: DocParagraph["align"];
  before?: number; // pt
  after?: number; // pt
}
interface ThemeFonts {
  major: string;
  minor: string;
}
interface Style {
  basedOn?: string;
  r: RProps;
  p: PProps;
}
export interface Styles {
  defR: RProps;
  defP: PProps;
  byId: Map<string, Style>;
  defParaId?: string;
  theme: ThemeFonts;
}

// later values win; undefined never overrides
function merge<T extends object>(base: T, over: T): T {
  const out = { ...base };
  for (const k of Object.keys(over) as (keyof T)[]) {
    if (over[k] !== undefined) out[k] = over[k];
  }
  return out;
}

function readRPr(rPr: Element | null, th: ThemeFonts): RProps {
  if (!rPr) return {};
  const f = kid(rPr, "rFonts");
  const theme = attr(f, "asciiTheme");
  const font = theme
    ? theme.startsWith("major")
      ? th.major
      : th.minor
    : (attr(f, "ascii") ?? attr(f, "hAnsi"));
  const sz = attr(kid(rPr, "sz"), "val");
  const color = attr(kid(rPr, "color"), "val");
  const u = kid(rPr, "u");
  return {
    font,
    size: sz ? Number(sz) / 2 : undefined,
    color: color && color !== "auto" ? color : undefined,
    bold: flag(kid(rPr, "b")),
    italic: flag(kid(rPr, "i")),
    underline: u ? attr(u, "val") !== "none" : undefined,
  };
}

function readPPr(pPr: Element | null): PProps {
  if (!pPr) return {};
  const jc = attr(kid(pPr, "jc"), "val");
  const sp = kid(pPr, "spacing");
  const tw = (n: string) => {
    const v = attr(sp, n);
    return v === undefined ? undefined : Number(v) / 20;
  };
  const align =
    jc === "center"
      ? "center"
      : jc === "right" || jc === "end"
        ? "right"
        : jc === "both" || jc === "distribute"
          ? "justify"
          : jc === "left" || jc === "start"
            ? "left"
            : undefined;
  return { align, before: tw("before"), after: tw("after") };
}

// ---- theme + styles.xml ----
function readTheme(zip: PizZip): ThemeFonts {
  const out: ThemeFonts = { major: "Calibri", minor: "Calibri" };
  const xml = zip.file("word/theme/theme1.xml")?.asText();
  if (!xml) return out;
  const doc = parseXml(xml);
  const latin = (tag: string) => {
    const f = doc.getElementsByTagName(tag)[0];
    const l = f
      ? elementChildren(f as Element).find((c) => c.localName === "latin")
      : null;
    return l?.getAttribute("typeface") || undefined;
  };
  return {
    major: latin("a:majorFont") ?? out.major,
    minor: latin("a:minorFont") ?? out.minor,
  };
}

export function loadStyles(zip: PizZip): Styles {
  const theme = readTheme(zip);
  const st: Styles = { defR: {}, defP: {}, byId: new Map(), theme };
  const xml = zip.file("word/styles.xml")?.asText();
  if (!xml) return st;
  const root = parseXml(xml).documentElement as Element;
  const dd = kid(root, "docDefaults");
  st.defR = readRPr(kid(kid(dd, "rPrDefault"), "rPr"), theme);
  st.defP = readPPr(kid(kid(dd, "pPrDefault"), "pPr"));
  for (const s of kids(root, "style")) {
    const id = attr(s, "styleId");
    if (!id) continue;
    st.byId.set(id, {
      basedOn: attr(kid(s, "basedOn"), "val"),
      r: readRPr(kid(s, "rPr"), theme),
      p: readPPr(kid(s, "pPr")),
    });
    if (attr(s, "type") === "paragraph" && attr(s, "default") === "1")
      st.defParaId = id;
  }
  return st;
}

// base style first, most specific last
function styleChain(st: Styles, id: string | undefined): Style[] {
  const chain: Style[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const s = st.byId.get(id);
    if (!s) break;
    chain.unshift(s);
    id = s.basedOn;
  }
  return chain;
}

// ---- runs and paragraphs ----
const RUN_WRAPPERS = new Set([
  "hyperlink",
  "ins",
  "smartTag",
  "fldSimple",
  "sdt",
  "sdtContent",
  "customXml",
]);

// All <w:r> of a paragraph in document order, including those inside hyperlinks etc.
// The index in this list IS DocRun.run (step 7 relies on it). Deleted text is skipped.
export function collectRuns(el: Element): Element[] {
  const out: Element[] = [];
  for (const c of elementChildren(el)) {
    if (c.localName === "r") out.push(c);
    else if (RUN_WRAPPERS.has(c.localName)) out.push(...collectRuns(c));
  }
  return out;
}

function runContent(r: Element): { text: string; image: boolean } {
  let text = "";
  let image = false;
  for (const c of elementChildren(r)) {
    switch (c.localName) {
      case "t":
        text += c.textContent ?? "";
        break;
      case "tab":
        text += "\t";
        break;
      case "br":
      case "cr":
        text += "\n";
        break;
      case "noBreakHyphen":
        text += "-";
        break;
      case "drawing":
      case "pict":
        image = true;
        break;
    }
  }
  return { text, image };
}

export function readParagraph(
  p: Element,
  addr: DocAddr,
  st: Styles,
): DocParagraph {
  const pPr = kid(p, "pPr");
  let pp = st.defP;
  let rp = st.defR;
  for (const s of styleChain(
    st,
    attr(kid(pPr, "pStyle"), "val") ?? st.defParaId,
  )) {
    pp = merge(pp, s.p);
    rp = merge(rp, s.r);
  }
  pp = merge(pp, readPPr(pPr));

  let offset = 0;
  const runs: DocRun[] = collectRuns(p).map((r, i) => {
    const rPr = kid(r, "rPr");
    let cp = rp;
    for (const s of styleChain(st, attr(kid(rPr, "rStyle"), "val")))
      cp = merge(cp, s.r);
    cp = merge(cp, readRPr(rPr, st.theme));

    const { text, image } = runContent(r);
    const run: DocRun = {
      text,
      font: cp.font ?? "Calibri",
      size: cp.size ?? 11,
      run: i,
      offset,
    };
    if (cp.bold) run.bold = true;
    if (cp.italic) run.italic = true;
    if (cp.underline) run.underline = true;
    if (cp.color) run.color = cp.color;
    if (image) run.image = true;
    offset += text.length;
    return run;
  });

  const para: DocParagraph = {
    type: "p",
    addr,
    align: pp.align ?? "left",
    runs,
  };
  if (pp.before) para.spaceBefore = pp.before;
  if (pp.after) para.spaceAfter = pp.after;
  const pbb = kid(pPr, "pageBreakBefore");
  if (pbb && !["0", "false", "off"].includes(attr(pbb, "val") ?? ""))
    para.pageBreakBefore = true;
  return para;
}

// ---- page size and margins (last section = direct <w:sectPr> of the body) ----
export function readPage(body: Element | null): DocModel["page"] {
  const sect = body ? kids(body, "sectPr").pop() : undefined;
  const sz = kid(sect, "pgSz");
  const mar = kid(sect, "pgMar");
  const pt = (el: Element | null, name: string, def: number) => {
    const raw = attr(el, name);
    const v = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(v) && v >= 0 ? v / 20 : def;
  };
  return {
    width: pt(sz, "w", 595.3), // A4 by default
    height: pt(sz, "h", 841.9),
    margin: {
      top: pt(mar, "top", 72),
      right: pt(mar, "right", 72),
      bottom: pt(mar, "bottom", 72),
      left: pt(mar, "left", 72),
    },
  };
}

// ---- blocks and tables ----
// addr.path = element-child indexes at each level (paragraph in body: [i]; in a table cell: [tbl, tr, tc, p])
function readBlocks(
  container: Element,
  base: number[],
  part: string,
  st: Styles,
): DocBlock[] {
  const out: DocBlock[] = [];
  elementChildren(container).forEach((c, i) => {
    const addr: DocAddr = { part, path: [...base, i] };
    if (c.localName === "p") out.push(readParagraph(c, addr, st));
    else if (c.localName === "tbl") out.push(readTable(c, addr, st));
  });
  return out;
}

function readTable(tbl: Element, addr: DocAddr, st: Styles): DocTable {
  const rows: DocTable["rows"] = [];
  let maxSpan = 0;
  elementChildren(tbl).forEach((tr, ti) => {
    if (tr.localName !== "tr") return;
    const cells: DocCell[] = [];
    let spanSum = 0;
    elementChildren(tr).forEach((tc, ci) => {
      if (tc.localName !== "tc") return;
      const tcPr = kid(tc, "tcPr");
      const span = Math.max(1, Number(attr(kid(tcPr, "gridSpan"), "val")) || 1);
      const fill = attr(kid(tcPr, "shd"), "fill");
      const cell: DocCell = {
        span,
        blocks: readBlocks(tc, [...addr.path, ti, ci], addr.part, st),
      };
      if (fill && fill !== "auto") cell.shade = fill;
      cells.push(cell);
      spanSum += span;
    });
    maxSpan = Math.max(maxSpan, spanSum);
    rows.push({ cells });
  });

  // column widths from <w:tblGrid>, as fractions of the whole
  const g = kid(tbl, "tblGrid");
  const grid = g
    ? kids(g, "gridCol").map((c) => Number(attr(c, "w")) || 0)
    : [];
  const n = Math.max(grid.length, maxSpan, 1);
  const known = grid.filter((w) => w > 0);
  const avg = known.length
    ? known.reduce((a, b) => a + b, 0) / known.length
    : 1;
  const widths = Array.from({ length: n }, (_, i) =>
    grid[i] > 0 ? grid[i] : avg,
  );
  const sum = widths.reduce((a, b) => a + b, 0);
  return { type: "table", addr, colWidths: widths.map((w) => w / sum), rows };
}

const hasContent = (bs: DocBlock[]): boolean =>
  bs.some((b) =>
    b.type === "p"
      ? b.runs.some((r) => r.text.trim() || r.image)
      : b.rows.some((r) => r.cells.some((c) => hasContent(c.blocks))),
  );

// ---- headers and footers (from the last section's references) ----
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function relTargets(zip: PizZip): Map<string, string> {
  const m = new Map<string, string>();
  const xml = zip.file("word/_rels/document.xml.rels")?.asText();
  if (!xml) return m;
  for (const r of Array.from(
    parseXml(xml).getElementsByTagName("Relationship"),
  )) {
    const id = r.getAttribute("Id");
    const t = r.getAttribute("Target");
    if (id && t) m.set(id, t.startsWith("/") ? t.slice(1) : "word/" + t);
  }
  return m;
}

// "default" header/footer, else "first"
function refTarget(
  sect: Element | undefined,
  tag: "headerReference" | "footerReference",
  rels: Map<string, string>,
): string | undefined {
  if (!sect) return undefined;
  const refs = kids(sect, tag);
  const byType = (t: string) =>
    refs.find((r) => (attr(r, "type") ?? "default") === t);
  const ref = byType("default") ?? byType("first");
  const id = ref
    ? ref.getAttributeNS(R, "id") || ref.getAttribute("r:id")
    : null;
  return id ? rels.get(id) : undefined;
}

// ---- entry point ----
export function readDocxModel(buf: Uint8Array): DocModel {
  let zip: PizZip;
  try {
    zip = new PizZip(buf);
  } catch {
    throw new Error("This file is not a valid .docx");
  }
  const docXml = zip.file("word/document.xml")?.asText();
  const body = docXml
    ? kid(parseXml(docXml).documentElement as Element, "body")
    : null;
  if (!body) throw new Error("This file is not a valid .docx");

  const st = loadStyles(zip);
  const rels = relTargets(zip);
  const sect = kids(body, "sectPr").pop();

  const partOf = (
    target: string | undefined,
    kind: "header" | "footer",
  ): DocPart[] => {
    const xml = target ? zip.file(target)?.asText() : undefined;
    if (!target || !xml) return [];
    const blocks = readBlocks(
      parseXml(xml).documentElement as Element,
      [],
      target,
      st,
    );
    return hasContent(blocks) ? [{ part: target, kind, blocks }] : [];
  };

  return {
    page: readPage(body),
    defaultFont: st.defR.font ?? "Calibri",
    parts: [
      ...partOf(refTarget(sect, "headerReference", rels), "header"),
      {
        part: "word/document.xml",
        kind: "body",
        blocks: readBlocks(body, [], "word/document.xml", st),
      },
      ...partOf(refTarget(sect, "footerReference", rels), "footer"),
    ],
  };
}
