import assert from "node:assert/strict";
import {
  validateMapping,
  MAX_MAPPINGS,
} from "../src/main/services/mappingRules";

const addr = (n = 0) => ({ part: "word/document.xml", path: [n] });
const field = (tag: string, text = "BK/1", n = 0) => ({
  kind: "field",
  addr: addr(n),
  start: 5,
  end: 5 + text.length,
  text,
  tag,
});
const txt = (tag: string, text = "Rahul Sen", n = 0) => ({
  kind: "text",
  addr: addr(n),
  start: 0,
  end: text.length,
  text,
  tag,
});
const table = (tag = "@table", n = 0) => ({
  kind: "table",
  addr: addr(n),
  tag,
});

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
const err = (x: unknown) => {
  const r = validateMapping(x);
  assert.equal(r.ok, false, "expected a rejection");
  return (r as { error: string }).error;
};

test("empty list is fine", () => {
  const r = validateMapping([]);
  assert.ok(r.ok && r.mapping.length === 0 && r.texts.length === 0);
});

test("valid field, text and table pass; texts are collected", () => {
  const r = validateMapping([field("ref_no"), txt("signatory_name"), table()]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.mapping.length, 3);
    assert.deepEqual(r.texts, [{ key: "signatory_name", value: "Rahul Sen" }]);
  }
});

test("not a list / too many", () => {
  assert.match(err({}), /not a list/);
  assert.match(err(Array(MAX_MAPPINGS + 1).fill(field("total"))), /Too many/);
});

test("field tag must be one the app fills", () => {
  assert.match(err([field("payee_name")]), /not a field/);
  assert.match(err([field("constructor")]), /not a field/);
  assert.match(err([field("__proto__")]), /not a field/);
  assert.match(err([field("table")]), /not a field/);
});

test("saved-text name: format and reserved names", () => {
  assert.match(err([txt("Bad Name")]), /lowercase/);
  assert.match(err([txt("1abc")]), /lowercase/);
  assert.match(err([txt("a".repeat(41))]), /lowercase/);
  assert.match(err([txt("date")]), /fills itself/);
  assert.match(err([txt("total")]), /fills itself/);
  assert.match(err([txt("sno")]), /fills itself/);
  assert.match(err([txt("table")]), /fills itself/);
});

test("same saved-text name twice: same text ok, different text rejected", () => {
  const ok = validateMapping([
    txt("signatory_name", "Rahul Sen", 0),
    txt("signatory_name", "Rahul Sen", 4),
  ]);
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.texts.length, 1);
  assert.match(
    err([
      txt("signatory_name", "Rahul Sen", 0),
      txt("signatory_name", "Asha Roy", 4),
    ]),
    /two different texts/,
  );
});

test("table must be {@table}, and only one", () => {
  assert.match(err([table("total")]), /only be \{@table\}/);
  assert.match(err([table("@table", 1), table("@table", 2)]), /Only one table/);
});

test("bad selection: end before start, text length mismatch, negatives, floats", () => {
  assert.match(err([{ ...field("total"), end: 5 }]), /selection/);
  assert.match(err([{ ...field("total"), text: "x" }]), /selection/);
  assert.match(err([{ ...field("total"), start: -1 }]), /selection/);
  assert.match(err([{ ...field("total"), start: 1.5 }]), /selection/);
  const noText: any = field("total");
  delete noText.text;
  assert.match(err([noText]), /selection/);
});

test("bad address: part name, empty/negative/huge path", () => {
  const withAddr = (a: unknown) => ({ ...field("total"), addr: a });
  assert.match(
    err([withAddr({ part: "../evil.xml", path: [0] })]),
    /invalid place/,
  );
  assert.match(
    err([withAddr({ part: "word/document.xml", path: [] })]),
    /invalid place/,
  );
  assert.match(
    err([withAddr({ part: "word/document.xml", path: [-1] })]),
    /invalid place/,
  );
  assert.match(
    err([withAddr({ part: "word/document.xml", path: Array(51).fill(0) })]),
    /invalid place/,
  );
  assert.match(err([withAddr(null)]), /invalid place/);
});

test("junk entries and unknown kinds", () => {
  assert.match(err([null]), /not valid/);
  assert.match(err([{ ...field("total"), kind: "other" }]), /unknown kind/);
  assert.match(err([{ ...field("total"), tag: 5 }]), /no name/);
});

test("output is a clean copy: extra properties dropped, input not shared", () => {
  const src: any = { ...field("total"), evil: "x" };
  const r = validateMapping([src]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(!("evil" in r.mapping[0]));
    r.mapping[0].addr.path[0] = 99;
    assert.equal(src.addr.path[0], 0);
  }
});

test("saved text longer than 2000 characters is rejected", () => {
  assert.match(err([txt("long_text", "x".repeat(2001))]), /longer than/);
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
