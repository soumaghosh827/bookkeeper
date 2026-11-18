import assert from "node:assert/strict";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { readDocxModel } from "../src/main/services/docxModel";
import { applyMapping } from "../src/main/services/docxMap";
import type { DocAddr, DocBlock, DocMapping } from "../src/shared/types";

// ---------- fixture builders (no binary files: every .docx is built here) ----------
const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function docx(body: string): Buffer {
  const z = new PizZip();
  z.file(
    "[Content_Types].xml",
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  z.file(
    "_rels/.rels",
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  z.file(
    "word/document.xml",
    `${DECL}<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  );
  return z.generate({ type: "nodebuffer" });
}
const B = "<w:rPr><w:b/></w:rPr>";
const I = "<w:rPr><w:i/></w:rPr>";
const r = (t: string, rpr = "") =>
  `<w:r>${rpr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const p = (...runs: string[]) => `<w:p>${runs.join("")}</w:p>`;
const tc = (...ps: string[]) => `<w:tc><w:tcPr/>${ps.join("")}</w:tc>`;
const tbl = (rows: string[][]) =>
  `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows
    .map((cells) => `<w:tr>${cells.map((c) => tc(p(r(c)))).join("")}</w:tr>`)
    .join("")}</w:tbl>`;

// ---------- helpers ----------
const xmlOf = (buf: Buffer) =>
  new PizZip(buf).file("word/document.xml")!.asText();

function walk(bs: DocBlock[], fn: (b: DocBlock) => void) {
  for (const b of bs) {
    fn(b);
    if (b.type === "table")
      b.rows.forEach((row) => row.cells.forEach((c) => walk(c.blocks, fn)));
  }
}
function paraTexts(buf: Buffer): string[] {
  const out: string[] = [];
  for (const part of readDocxModel(buf).parts)
    walk(part.blocks, (b) => {
      if (b.type === "p") out.push(b.runs.map((x) => x.text).join(""));
    });
  return out;
}
function findPara(
  buf: Buffer,
  contains: string,
): { addr: DocAddr; text: string } {
  let hit: { addr: DocAddr; text: string } | undefined;
  for (const part of readDocxModel(buf).parts)
    walk(part.blocks, (b) => {
      if (b.type !== "p" || hit) return;
      const text = b.runs.map((x) => x.text).join("");
      if (text.includes(contains)) hit = { addr: b.addr, text };
    });
  if (!hit) throw new Error(`fixture: no paragraph contains "${contains}"`);
  return hit;
}
/** A mapping for the text `covered` inside the paragraph that contains `contains`. */
function m(
  buf: Buffer,
  contains: string,
  covered: string,
  tag: string,
): DocMapping {
  const { addr, text } = findPara(buf, contains);
  const start = text.indexOf(covered);
  if (start < 0) throw new Error(`fixture: "${covered}" not in "${text}"`);
  return {
    kind: "field",
    addr,
    start,
    end: start + covered.length,
    text: covered,
    tag,
  };
}
function tableMap(buf: Buffer, nth = 0): DocMapping {
  const addrs: DocAddr[] = [];
  for (const part of readDocxModel(buf).parts)
    walk(part.blocks, (b) => {
      if (b.type === "table") addrs.push(b.addr);
    });
  return { kind: "table", addr: addrs[nth], tag: "@table" };
}
const opts = { paragraphLoop: true, linebreaks: true };
const compiles = (buf: Buffer) => new Docxtemplater(new PizZip(buf), opts); // throws on a broken tag
function render(buf: Buffer, data: Record<string, string>): string {
  const d = compiles(buf);
  d.render(data);
  return d.getFullText();
}
/** apply + compile; returns the new file and its paragraph texts */
function run(src: Buffer, ms: DocMapping[]) {
  const out = applyMapping(src, ms);
  compiles(out);
  return { out, texts: paraTexts(out) };
}
const runXml = (buf: Buffer, needle: string) => {
  const x = xmlOf(buf);
  const i = x.indexOf(needle);
  return x.slice(x.lastIndexOf("<w:r>", i), x.indexOf("</w:r>", i));
};
const count = (buf: Buffer, re: RegExp) => (xmlOf(buf).match(re) ?? []).length;

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log("  ok   " + name);
  } catch (e: any) {
    failed++;
    console.log("  FAIL " + name + "\n       " + (e?.message ?? e));
  }
}

// ---------- tests ----------
test("no mappings: text and validity unchanged, XML declaration kept", () => {
  const src = docx(p(r("Hello "), r("world", B)) + p(r("Second")));
  const { out, texts } = run(src, []);
  assert.deepEqual(texts, ["Hello world", "Second"]);
  assert.ok(xmlOf(out).startsWith("<?xml"));
});

test("tag split across three runs: goes in the first covered run, keeps its formatting, empty runs removed", () => {
  const src = docx(p(r("Ref No: "), r("BK/12", B), r("/20", I), r("26 dated")));
  const { out, texts } = run(src, [m(src, "Ref No", "BK/12/2026", "ref_no")]);
  assert.deepEqual(texts, ["Ref No: {ref_no} dated"]);
  assert.equal(count(out, /<w:r>/g), 3);
  const tagRun = runXml(out, "{ref_no}");
  assert.ok(tagRun.includes("<w:b/>") && !tagRun.includes("<w:i/>"));
  assert.ok(render(out, { ref_no: "X/9" }).includes("Ref No: X/9 dated"));
});

test("selection inside one run keeps the text before and after", () => {
  const src = docx(p(r("Dear Sir, Rs. 1,50,000/- only")));
  const { texts } = run(src, [m(src, "Dear Sir", "Rs. 1,50,000/-", "total")]);
  assert.deepEqual(texts, ["Dear Sir, {total} only"]);
});

test("whole paragraph covered", () => {
  const src = docx(p(r("Rs. 500")) + p(r("next")));
  const { texts } = run(src, [m(src, "Rs. 500", "Rs. 500", "total")]);
  assert.deepEqual(texts, ["{total}", "next"]);
});

test("amount and words in one paragraph (two mappings)", () => {
  const src = docx(
    p(
      r("Total Rs. 1,50,000/- "),
      r("(Rupees One Lakh Fifty Thousand Only)", B),
    ),
  );
  const { out, texts } = run(src, [
    m(src, "Total", "Rs. 1,50,000/-", "total"),
    m(src, "Total", "(Rupees One Lakh Fifty Thousand Only)", "total_words"),
  ]);
  assert.deepEqual(texts, ["Total {total} {total_words}"]);
  assert.ok(
    render(out, { total: "Rs. 5", total_words: "Rupees Five Only" }).includes(
      "Total Rs. 5 Rupees Five Only",
    ),
  );
});

test("adjacent selections inside the same run", () => {
  const src = docx(p(r("AAA BBB CCC")));
  const { texts } = run(src, [
    m(src, "AAA", "AAA", "first"),
    m(src, "AAA", "BBB", "second"),
  ]);
  assert.deepEqual(texts, ["{first} {second} CCC"]);
});

test("selection that starts on a tab", () => {
  const src = docx(
    p(r("Date:"), `<w:r><w:tab/>${`<w:t>18/11/2026</w:t>`}</w:r>`),
  );
  assert.deepEqual(paraTexts(src), ["Date:\t18/11/2026"]);
  const { texts } = run(src, [m(src, "Date:", "\t18/11/2026", "today")]);
  assert.deepEqual(texts, ["Date:{today}"]);
});

test("selection that crosses a line break", () => {
  const src = docx(
    p(`<w:r><w:t>Line one</w:t><w:br/><w:t>Rs. 500</w:t></w:r>`),
  );
  assert.deepEqual(paraTexts(src), ["Line one\nRs. 500"]);
  const { texts } = run(src, [m(src, "Line one", "one\nRs. 500", "total")]);
  assert.deepEqual(texts, ["Line {total}"]);
});

test("XML special characters are escaped correctly", () => {
  const src = docx(p(r("A &amp; B &lt;Ltd&gt; Payee: M/s X")));
  assert.deepEqual(paraTexts(src), ["A & B <Ltd> Payee: M/s X"]);
  const { out, texts } = run(src, [
    m(src, "Payee", "A & B", "payee_name"),
    m(src, "Payee", "M/s X", "remarks"),
  ]);
  assert.deepEqual(texts, ["{payee_name} <Ltd> Payee: {remarks}"]);
  assert.ok(
    render(out, { payee_name: "X & Y <Z>", remarks: "ok" }).includes(
      "X & Y <Z> <Ltd> Payee: ok",
    ),
  );
});

test("hyperlink: selection over the whole link removes the empty link", () => {
  const src = docx(
    p(
      r("Visit "),
      `<w:hyperlink r:id="rId9">${r("www.")}${r("site.com")}</w:hyperlink>`,
      r(" now"),
    ),
  );
  assert.deepEqual(paraTexts(src), ["Visit www.site.com now"]);
  const { out, texts } = run(src, [
    m(src, "Visit", "Visit www.site.com", "payee_name"),
  ]);
  assert.deepEqual(texts, ["{payee_name} now"]);
  assert.equal(count(out, /<w:hyperlink/g), 0);
});

test("hyperlink: selection inside a link keeps the link", () => {
  const src = docx(
    p(
      r("Visit "),
      `<w:hyperlink r:id="rId9">${r("www.")}${r("site.com")}</w:hyperlink>`,
    ),
  );
  const { out, texts } = run(src, [m(src, "Visit", "www.site", "payee_name")]);
  assert.deepEqual(texts, ["Visit {payee_name}.com"]);
  assert.equal(count(out, /<w:hyperlink/g), 1);
});

test("table replaced by {@table}; a paragraph inside another table still maps", () => {
  const src = docx(
    p(r("Intro")) +
      tbl([
        ["Sl. No.", "Name"],
        ["1", "Acme"],
      ]) +
      p(r("After")) +
      `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr>${tc(p(r("Payee: Acme")), p(r("x")))}</w:tr></w:tbl>`,
  );
  const { out, texts } = run(src, [
    tableMap(src, 0),
    m(src, "Payee:", "Acme", "payee_name"),
  ]);
  assert.deepEqual(texts, [
    "Intro",
    "{@table}",
    "After",
    "Payee: {payee_name}",
    "x",
  ]);
  assert.equal(count(out, /<w:tbl>/g), 1);
  const filled = render(out, {
    table: "<w:p><w:r><w:t>TBL</w:t></w:r></w:p>",
    payee_name: "Z",
  });
  assert.ok(filled.includes("TBL") && filled.includes("Payee: Z"));
});

test("paragraphs after a table and with pPr are addressed correctly", () => {
  const src = docx(
    tbl([["a", "b"]]) +
      `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${r("Centered Rs. 5")}</w:p>` +
      p(r("Rs. 5")),
  );
  const { texts } = run(src, [m(src, "Centered", "Rs. 5", "total")]);
  assert.deepEqual(texts, ["a", "b", "Centered {total}", "Rs. 5"]);
});

test("braces covered by the selection are fine", () => {
  const src = docx(p(r("Pay {x} Rs. 5")));
  const { texts } = run(src, [m(src, "Pay", "{x} Rs. 5", "total")]);
  assert.deepEqual(texts, ["Pay {total}"]);
});

// ---------- rejections ----------
test("rejects: braces left in a mapped paragraph", () => {
  const src = docx(p(r("Pay {x} Rs. 5")));
  assert.throws(
    () => applyMapping(src, [m(src, "Pay", "Rs. 5", "total")]),
    /already contains/,
  );
});
test("rejects: overlapping selections", () => {
  const src = docx(p(r("AAA BBB")));
  const a = m(src, "AAA", "AAA B", "first");
  const b = m(src, "AAA", "BBB", "second");
  assert.throws(() => applyMapping(src, [a, b]), /overlap/);
});
test("rejects: text no longer where it was mapped", () => {
  const src = docx(p(r("Hello world")));
  const bad = { ...m(src, "Hello", "world", "total"), text: "other" };
  assert.throws(
    () => applyMapping(src, [bad]),
    /no longer where it was mapped/,
  );
});
test("rejects: invalid tag name", () => {
  const src = docx(p(r("Hello")));
  assert.throws(
    () => applyMapping(src, [m(src, "Hello", "Hello", "Bad Tag")]),
    /not a valid field name/,
  );
});
test("rejects: selection outside the paragraph", () => {
  const src = docx(p(r("Hello")));
  assert.throws(
    () =>
      applyMapping(src, [{ ...m(src, "Hello", "Hello", "total"), end: 99 }]),
    /outside its paragraph/,
  );
});
test("rejects: path that does not exist", () => {
  const src = docx(p(r("Hello")));
  const bad = {
    ...m(src, "Hello", "Hello", "total"),
    addr: { part: "word/document.xml", path: [99] },
  };
  assert.throws(() => applyMapping(src, [bad]), /no longer matches/);
});
test("rejects: table mapping on a paragraph, paragraph mapping on a table", () => {
  const src = docx(p(r("Hello")) + tbl([["a", "b"]]));
  const onPara: DocMapping = {
    kind: "table",
    addr: findPara(src, "Hello").addr,
    tag: "@table",
  };
  assert.throws(() => applyMapping(src, [onPara]), /does not point at a table/);
  const onTable: DocMapping = {
    kind: "field",
    addr: tableMap(src).addr,
    start: 0,
    end: 1,
    tag: "total",
  };
  assert.throws(
    () => applyMapping(src, [onTable]),
    /does not point at a paragraph/,
  );
});
test("rejects: selection inside a table that is also being replaced", () => {
  const src = docx(tbl([["Sl", "Name"]]));
  assert.throws(
    () =>
      applyMapping(src, [tableMap(src), m(src, "Name", "Name", "payee_name")]),
    /inside a table/,
  );
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
