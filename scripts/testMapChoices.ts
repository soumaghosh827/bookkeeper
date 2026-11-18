import assert from "node:assert/strict";
import { buildMapping } from "../src/shared/mapChoices";
import { validateMapping } from "../src/main/services/mappingRules";
import type { DocSuggestion } from "../src/shared/types";

const sug = (id: string, over: Partial<DocSuggestion> = {}): DocSuggestion => ({
  id,
  kind: "field",
  addr: { part: "word/document.xml", path: [Number(id.slice(1))] },
  start: 4,
  end: 10,
  text: "BK/123",
  tag: "ref_no",
  options: ["ref_no"],
  confidence: "likely",
  reason: "test",
  ...over,
});
const tbl = (id: string): DocSuggestion =>
  sug(id, {
    kind: "table",
    tag: "@table",
    start: undefined,
    end: undefined,
    text: "Name | Amount",
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

test("nothing chosen gives an empty mapping", () => {
  assert.deepEqual(buildMapping([sug("s1"), tbl("s2")], {}), []);
});

test("only chosen suggestions are included, in document order", () => {
  const all = [sug("s1"), sug("s2"), sug("s3")];
  const m = buildMapping(all, {
    s3: { kind: "field", tag: "total" },
    s1: { kind: "field", tag: "ref_no" },
  });
  assert.deepEqual(
    m.map((x) => x.addr.path[0]),
    [1, 3],
  );
});

test("the user's own kind and tag win; text and offsets come from the suggestion", () => {
  const [m] = buildMapping([sug("s1", { text: "Rahul Sen", end: 13 })], {
    s1: { kind: "text", tag: "signatory_name" },
  });
  assert.equal(m.kind, "text");
  assert.equal(m.tag, "signatory_name");
  assert.equal(m.text, "Rahul Sen");
  assert.equal(m.start, 4);
  assert.equal(m.end, 13);
});

test("a chosen table becomes {@table} with no offsets", () => {
  const [m] = buildMapping([tbl("s1")], {
    s1: { kind: "table", tag: "@table" },
  });
  assert.deepEqual(m, {
    kind: "table",
    addr: { part: "word/document.xml", path: [1] },
    tag: "@table",
  });
});

test("ids that match no suggestion are ignored", () => {
  assert.deepEqual(
    buildMapping([sug("s1")], { s9: { kind: "field", tag: "total" } }),
    [],
  );
});

test("the address is a copy, not shared with the suggestion", () => {
  const s = sug("s1");
  const [m] = buildMapping([s], { s1: { kind: "field", tag: "total" } });
  m.addr.path[0] = 99;
  assert.equal(s.addr.path[0], 1);
});

test("the result passes the real validator", () => {
  const all = [sug("s1"), sug("s2", { text: "Rahul Sen", end: 13 }), tbl("s3")];
  const r = validateMapping(
    buildMapping(all, {
      s1: { kind: "field", tag: "ref_no" },
      s2: { kind: "text", tag: "signatory_name" },
      s3: { kind: "table", tag: "@table" },
    }),
  );
  assert.ok(r.ok);
  if (r.ok)
    assert.deepEqual(r.texts, [{ key: "signatory_name", value: "Rahul Sen" }]);
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
