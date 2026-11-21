import assert from "node:assert/strict";
import { findLeftovers } from "../src/shared/leftovers";
import type {
  DocAddr,
  DocBlock,
  DocModel,
  DocParagraph,
  DocSuggestion,
  DocTable,
} from "../src/shared/types";

const addr = (path: number[], part = "word/document.xml"): DocAddr => ({
  part,
  path,
});
const para = (path: number[], text: string, part?: string): DocParagraph => ({
  type: "p",
  addr: addr(path, part),
  align: "left",
  runs: [{ text, run: 0, offset: 0 }],
});
const table = (path: number[], inner: DocParagraph): DocTable => ({
  type: "table",
  addr: addr(path),
  colWidths: [1],
  rows: [{ cells: [{ span: 1, blocks: [inner] }] }],
});
const model = (body: DocBlock[], header: DocBlock[] = []): DocModel => ({
  page: {
    width: 595,
    height: 842,
    margin: { top: 72, right: 72, bottom: 72, left: 72 },
  },
  defaultFont: "Arial",
  parts: [
    { part: "word/document.xml", kind: "body", blocks: body },
    ...(header.length
      ? [{ part: "word/header1.xml", kind: "header" as const, blocks: header }]
      : []),
  ],
});
const sug = (
  id: string,
  p: DocParagraph,
  start: number,
  end: number,
  tag = "payee",
): DocSuggestion => ({
  id,
  kind: "field",
  addr: p.addr,
  start,
  end,
  text: p.runs[0].text.slice(start, end),
  tag,
  options: [tag],
  confidence: "likely",
  reason: "test",
});
const tbl = (id: string, t: DocTable): DocSuggestion => ({
  id,
  kind: "table",
  addr: t.addr,
  text: "Name | Amount",
  tag: "@table",
  options: ["@table"],
  confidence: "likely",
  reason: "test",
});
const PAYEE = { s1: { kind: "field", tag: "payee" } };

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

const dear = para([0], "Dear Rahul Sen,"); // "Rahul Sen" = 5..14
const subject = para([1], "Sub: payment to Rahul Sen");

test("nothing chosen gives no warnings", () => {
  assert.deepEqual(
    findLeftovers(model([dear, subject]), [sug("s1", dear, 5, 14)], {}),
    [],
  );
});

test("a chosen value that appears again is reported", () => {
  const r = findLeftovers(
    model([dear, subject]),
    [sug("s1", dear, 5, 14)],
    PAYEE,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].value, "Rahul Sen");
  assert.equal(r[0].count, 1);
  assert.equal(r[0].label, "First payee name");
  assert.equal(r[0].sample, "Sub: payment to Rahul Sen");
});

test("the chosen text itself is not counted", () => {
  assert.deepEqual(
    findLeftovers(model([dear]), [sug("s1", dear, 5, 14)], PAYEE),
    [],
  );
});

test("the match ignores capital letters", () => {
  const loud = para([1], "RAHUL SEN");
  const r = findLeftovers(model([dear, loud]), [sug("s1", dear, 5, 14)], PAYEE);
  assert.equal(r.length, 1);
});

test("several places add up", () => {
  const twice = para([1], "Rahul Sen and Rahul Sen");
  const r = findLeftovers(
    model([dear, twice, subject]),
    [sug("s1", dear, 5, 14)],
    PAYEE,
  );
  assert.equal(r[0].count, 3);
});

test("values shorter than 4 characters are ignored", () => {
  const a = para([0], "To SBI");
  const b = para([1], "SBI branch");
  const r = findLeftovers(model([a, b]), [sug("s1", a, 3, 6, "bank")], {
    s1: { kind: "field", tag: "bank" },
  });
  assert.deepEqual(r, []);
});

test("fields other than the payee ones are not checked", () => {
  const a = para([0], "Total Rs. 1,50,000");
  const b = para([1], "Please pay 1,50,000 today");
  const r = findLeftovers(model([a, b]), [sug("s1", a, 10, 18, "total")], {
    s1: { kind: "field", tag: "total" },
  });
  assert.deepEqual(r, []);
});

test("a value chosen as saved text is not checked", () => {
  const r = findLeftovers(model([dear, subject]), [sug("s1", dear, 5, 14)], {
    s1: { kind: "text", tag: "signatory_name" },
  });
  assert.deepEqual(r, []);
});

test("a copy inside a table that will be replaced is ignored", () => {
  const t = table([2], para([2, 0, 0, 0], "Rahul Sen"));
  const r = findLeftovers(
    model([dear, t]),
    [sug("s1", dear, 5, 14), tbl("t1", t)],
    {
      ...PAYEE,
      t1: { kind: "table", tag: "@table" },
    },
  );
  assert.deepEqual(r, []);
});

test("a copy inside a table that is kept is reported", () => {
  const t = table([2], para([2, 0, 0, 0], "Rahul Sen"));
  const r = findLeftovers(
    model([dear, t]),
    [sug("s1", dear, 5, 14), tbl("t1", t)],
    PAYEE,
  );
  assert.equal(r.length, 1);
});

test("a copy in the header is reported", () => {
  const h = para([0], "Rahul Sen & Co", "word/header1.xml");
  const r = findLeftovers(model([dear], [h]), [sug("s1", dear, 5, 14)], PAYEE);
  assert.equal(r.length, 1);
  assert.equal(r[0].sample, "Rahul Sen & Co");
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
