// Run: npx tsx scripts/test-move-table.ts
import assert from "node:assert/strict";
import PizZip from "pizzip";
import { moveTableToEnd } from "../src/main/services/docxMap";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const blank = "<w:p/>";
const br = '<w:r><w:br w:type="page"/></w:r>';
const brP = `<w:p>${br}</w:p>`;
const MARK = p("{@table}");
const SECT = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';

function docx(body: string): Buffer {
  const z = new PizZip();
  z.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${SECT}</w:body></w:document>`,
  );
  return z.generate({ type: "nodebuffer" });
}
const xmlOf = (b: Buffer) => new PizZip(b).file("word/document.xml")!.asText();
const run = (body: string) => xmlOf(moveTableToEnd(docx(body)));
const breaks = (s: string) => (s.match(/w:type="page"/g) ?? []).length;
const inOrder = (s: string, ...w: string[]) =>
  w.every((x, i) => s.includes(x) && (i === 0 || s.indexOf(w[i - 1]) < s.indexOf(x)));

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log("ok   ", name);
  } catch (e) {
    failed++;
    console.log("FAIL ", name, "\n     ", (e as Error).message);
  }
}

test("1 table alone on the last page: marker and its page break go", () => {
  const x = run(p("Dear Sir") + p("Yours") + brP + MARK + blank);
  assert.ok(!x.includes("{@table}"));
  assert.equal(breaks(x), 0);
  assert.ok(inOrder(x, "Dear Sir", "Yours"));
});

test("2 table mid-page 1, signatory below: marker goes, nothing else changes", () => {
  const x = run(p("Dear Sir") + MARK + p("Yours") + p("Signatory"));
  assert.ok(!x.includes("{@table}"));
  assert.equal(breaks(x), 0);
  assert.ok(inOrder(x, "Dear Sir", "Yours", "Signatory"));
});

test("3 lines after the table (Encl., cc), no page break", () => {
  const x = run(p("Body") + MARK + p("Encl.") + p("cc"));
  assert.ok(!x.includes("{@table}"));
  assert.equal(breaks(x), 0);
  assert.ok(inOrder(x, "Body", "Encl.", "cc"));
});

test("4 page break before the table, content after it: the break stays", () => {
  const x = run(p("Body") + brP + MARK + p("Encl."));
  assert.ok(!x.includes("{@table}"));
  assert.equal(breaks(x), 1);
  assert.ok(inOrder(x, "Body", "Encl."));
});

test("5 no table in the letter: file returned unchanged", () => {
  const f = docx(p("Hello") + brP);
  assert.equal(moveTableToEnd(f), f);
});

test("6 break at the end of a text paragraph: break goes, text stays", () => {
  const x = run(
    p("Body") + `<w:p><w:r><w:t>Signatory</w:t></w:r>${br}</w:p>` + MARK,
  );
  assert.ok(!x.includes("{@table}"));
  assert.equal(breaks(x), 0);
  assert.ok(x.includes("Signatory"));
});

test("7 empty paragraphs between the break and the table", () => {
  const x = run(p("Body") + brP + blank + blank + MARK);
  assert.equal(breaks(x), 0);
});

test("8 text after the break in the same paragraph: the break stays", () => {
  const x = run(
    p("Body") + `<w:p>${br}<w:r><w:t>More</w:t></w:r></w:p>` + MARK,
  );
  assert.equal(breaks(x), 1);
  assert.ok(x.includes("More"));
});

test("9 two breaks: only the one right before the table goes", () => {
  const x = run(p("Body") + brP + p("Page two text") + brP + MARK);
  assert.equal(breaks(x), 1);
  assert.ok(inOrder(x, "Body", "Page two text"));
});

if (failed) process.exit(1);
console.log("all passed");