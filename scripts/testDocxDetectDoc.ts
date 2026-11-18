import assert from "node:assert/strict";
import { detectDocument } from "../src/main/services/docxDetectDoc";
import type {
  DocAddr,
  DocBlock,
  DocModel,
  DocParagraph,
  DocPart,
  DocSuggestion,
  DocTable,
} from "../src/shared/types";

// ---------- fixture builders (DocModel objects built directly: no .docx files) ----------
const A = (path: number[], part = "word/document.xml"): DocAddr => ({
  part,
  path,
});
/** A paragraph; several strings = several runs, offsets worked out like docxModel does */
function P(path: number[], ...texts: string[]): DocParagraph {
  let offset = 0;
  return {
    type: "p",
    addr: A(path),
    align: "left",
    runs: texts.map((text, i) => {
      const run = { text, run: i, offset };
      offset += text.length;
      return run;
    }),
  };
}
const cell = (...blocks: DocBlock[]) => ({ span: 1, blocks });
function T(path: number[], rows: string[][]): DocTable {
  return {
    type: "table",
    addr: A(path),
    colWidths: rows[0].map(() => 1 / rows[0].length),
    rows: rows.map((cells, ri) => ({
      cells: cells.map((c, ci) => cell(P([...path, ri, ci, 0], c))),
    })),
  };
}
const model = (...parts: DocPart[]): DocModel => ({
  page: {
    width: 595,
    height: 842,
    margin: { top: 72, right: 72, bottom: 72, left: 72 },
  },
  defaultFont: "Calibri",
  parts,
});
const body = (...blocks: DocBlock[]): DocPart => ({
  part: "word/document.xml",
  kind: "body",
  blocks,
});

// ---------- helpers ----------
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
const texts = (s: DocSuggestion[]) => s.map((x) => x.text);
const by = (s: DocSuggestion[], text: string) => {
  const hit = s.find((x) => x.text === text);
  if (!hit) throw new Error(`no suggestion for "${text}" in [${texts(s)}]`);
  return hit;
};

// ---------- tests ----------
test("empty document gives no suggestions", () => {
  assert.deepEqual(detectDocument(model(body())), []);
  assert.deepEqual(detectDocument(model(body(P([0], ""), P([1], "   ")))), []);
});

test("paragraph hit: offsets, address, id and kind carried over", () => {
  const s = detectDocument(model(body(P([0], "Our Ref: BK/12/2026"))));
  assert.equal(s.length, 1);
  assert.equal(s[0].id, "s1");
  assert.equal(s[0].kind, "field");
  assert.equal(s[0].tag, "ref_no");
  assert.deepEqual(s[0].addr, A([0]));
  assert.equal("Our Ref: BK/12/2026".slice(s[0].start, s[0].end), "BK/12/2026");
});

test("a value split over several runs keeps paragraph-wide offsets", () => {
  const s = detectDocument(
    model(body(P([0], "Ref No: BK/", "12/", "2026 dated"))),
  );
  const ref = by(s, "BK/12/2026");
  assert.equal(
    "Ref No: BK/12/2026 dated".slice(ref.start, ref.end),
    "BK/12/2026",
  );
});

test("ids are unique and in document order across body, header and footer", () => {
  const header: DocPart = {
    part: "word/header1.xml",
    kind: "header",
    blocks: [
      { ...P([0], "Ref No: HDR/1/2026"), addr: A([0], "word/header1.xml") },
    ],
  };
  const s = detectDocument(
    model(
      header,
      body(P([0], "Dated 12 November 2026"), P([1], "Rs. 5,000/-")),
    ),
  );
  assert.deepEqual(
    s.map((x) => x.id),
    s.map((_, i) => `s${i + 1}`),
  );
  assert.equal(s[0].addr.part, "word/header1.xml");
  assert.equal(new Set(s.map((x) => x.id)).size, s.length);
});

test("label cell next to value cell: the value is found", () => {
  const s = detectDocument(
    model(
      body(
        T(
          [0],
          [
            ["Ref No", "BK/12/2026"],
            ["Dated", "12 November 2026"],
          ],
        ),
      ),
    ),
  );
  assert.equal(by(s, "BK/12/2026").tag, "ref_no");
  assert.equal(by(s, "12 November 2026").tag, "today");
});

test("the same value without a label cell is only a possibility", () => {
  const s = detectDocument(model(body(P([0], "BK/12/2026"))));
  assert.equal(s[0].confidence, "possible");
});

test("report table: offered as {@table} with matched headers and row count", () => {
  const t = T(
    [0],
    [
      [
        "Sl. No.",
        "Beneficiary Name",
        "Bank",
        "Account Number",
        "IFSC",
        "Amount",
      ],
      ["1", "Asha Roy", "SBI", "123456789012", "SBIN0001234", "1,000.00"],
      ["2", "Ravi Das", "HDFC", "998877665544", "HDFC0004321", "2,000.00"],
    ],
  );
  const s = detectDocument(model(body(t)));
  assert.equal(s.length, 1, "inner cells must not give field suggestions");
  assert.equal(s[0].kind, "table");
  assert.equal(s[0].tag, "@table");
  assert.deepEqual(s[0].addr, A([0]));
  assert.equal(s[0].table?.rows, 2);
  assert.equal(s[0].table?.matched.length, 6);
  assert.equal(s[0].confidence, "likely");
});

test("report table with a title row above the headers", () => {
  const t = T(
    [0],
    [
      ["Payment list", "", ""],
      ["Name", "Bank", "Amount"],
      ["Asha Roy", "SBI", "1,000.00"],
    ],
  );
  const s = detectDocument(model(body(t)));
  assert.equal(s[0]?.kind, "table");
  assert.equal(s[0].table?.rows, 1);
});

test("header-only table (no data rows) is not offered", () => {
  const t = T([0], [["Name", "Bank", "Amount"]]);
  assert.equal(
    detectDocument(model(body(t))).filter((x) => x.kind === "table").length,
    0,
  );
});

test("letterhead layout table is skipped", () => {
  const t = T(
    [0],
    [["Book Keeper & Co.", "12 Park Street, Kolkata", "Phone 98300 00000"]],
  );
  assert.equal(
    detectDocument(model(body(t))).filter((x) => x.kind === "table").length,
    0,
  );
});

test("a table that only matches two columns is not offered", () => {
  const t = T(
    [0],
    [
      ["Item", "Bank", "Amount"],
      ["Pen", "SBI", "10"],
    ],
  );
  assert.equal(
    detectDocument(model(body(t))).filter((x) => x.kind === "table").length,
    0,
  );
});

test("signatory lines after 'Yours faithfully' are offered as saved text", () => {
  const s = detectDocument(
    model(
      body(
        P([0], "Yours faithfully"),
        P([1], ""),
        P([2], "Rahul Sen"),
        P([3], "Manager (Accounts)"),
      ),
    ),
  );
  const txt = s.filter((x) => x.kind === "text");
  assert.deepEqual(
    txt.map((x) => x.text),
    ["Rahul Sen", "Manager (Accounts)"],
  );
  assert.deepEqual(
    txt.map((x) => x.tag),
    ["signatory_name", "signatory_designation"],
  );
  assert.ok(txt.every((x) => /^[a-z][a-z0-9_]{0,39}$/.test(x.tag)));
  assert.equal("Rahul Sen".slice(txt[0].start, txt[0].end), "Rahul Sen");
});

test("signature block stops at Encl. / long lines / lines that hold a value", () => {
  const s = detectDocument(
    model(
      body(
        P([0], "Yours faithfully"),
        P([1], "Rahul Sen"),
        P([2], "Encl: statement"),
        P([3], "Another name"),
      ),
    ),
  );
  assert.deepEqual(
    s.filter((x) => x.kind === "text").map((x) => x.text),
    ["Rahul Sen"],
  );
});

test("no closing phrase means no saved-text suggestions", () => {
  const s = detectDocument(model(body(P([0], "Rahul Sen"), P([1], "Manager"))));
  assert.equal(s.filter((x) => x.kind === "text").length, 0);
});

test("amount and its words in adjacent paragraphs are paired", () => {
  const s = detectDocument(
    model(
      body(
        P([0], "Total payable: Rs. 1,50,000/-"),
        P([1], "(Rupees One Lakh Fifty Thousand Only)"),
      ),
    ),
  );
  const a = by(s, "Rs. 1,50,000/-");
  const w = by(s, "Rupees One Lakh Fifty Thousand Only");
  assert.equal(a.tag, "total");
  assert.equal(w.tag, "total_words");
  assert.equal(a.confidence, "likely");
  assert.equal(w.confidence, "likely");
  assert.ok(a.reason.startsWith("Matches the amount in words"));
  assert.equal(w.reason, "Matches Rs. 1,50,000/-");
});

test("an amount whose words differ is not paired", () => {
  const s = detectDocument(
    model(body(P([0], "Rs. 1,50,000/-"), P([1], "(Rupees Two Lakh Only)"))),
  );
  assert.ok(
    !by(s, "Rs. 1,50,000/-").reason.startsWith("Matches the amount in words"),
  );
});

test("suggestions never overlap inside one paragraph", () => {
  const s = detectDocument(
    model(
      body(P([0], "Ref: BK/12/2026 dated 12 November 2026 for Rs. 1,50,000/-")),
    ),
  );
  const same = s
    .filter((x) => x.addr.path[0] === 0)
    .sort((a, b) => a.start! - b.start!);
  for (let i = 1; i < same.length; i++)
    assert.ok(same[i].start! >= same[i - 1].end!);
});

test("an amount that differs from the one matching the words is only a possibility", () => {
  const s = detectDocument(
    model(
      body(
        P(
          [0],
          "Transfer Rs. 3,54,988.00, Rs. 4,74,288.00 (Rupees Four Lakh Seventy Four Thousand Two Hundred Eighty Eight Only)",
        ),
      ),
    ),
  );
  const odd = by(s, "Rs. 3,54,988.00");
  const real = by(s, "Rs. 4,74,288.00");
  assert.equal(odd.confidence, "possible");
  assert.match(odd.reason, /Different from the amount in words/);
  assert.equal(real.confidence, "likely");
});

test("without any amount matching words, amounts keep their own confidence", () => {
  const s = detectDocument(
    model(body(P([0], "Pay Rs. 3,54,988.00 and Rs. 1,000.00"))),
  );
  assert.ok(s.every((x) => x.confidence === "likely"));
});

test("a document with a payee table: single-payee fields drop to possible, report-level stay likely", () => {
  const t = T(
    [1],
    [
      [
        "Sl. No.",
        "Beneficiary Name",
        "Bank",
        "Account Number",
        "IFSC",
        "Amount",
      ],
      ["1", "Asha Roy", "SBI", "123456789012", "SBIN0001234", "1,000.00"],
    ],
  );
  const s = detectDocument(
    model(
      body(
        P(
          [0],
          "Ref: BK/12/2026 Date: 18/11/2026 Cash Credit A/c No. 1234567890",
        ),
        t,
      ),
    ),
  );
  const acc = by(s, "1234567890");
  assert.equal(acc.tag, "account_no");
  assert.equal(acc.confidence, "possible");
  assert.match(acc.reason, /table of payees/);
  assert.equal(by(s, "BK/12/2026").confidence, "likely");
  assert.equal(by(s, "18/11/2026").confidence, "likely");
});

test("the same account number without a payee table stays likely", () => {
  const s = detectDocument(
    model(body(P([0], "Cash Credit A/c No. 1234567890"))),
  );
  assert.equal(by(s, "1234567890").confidence, "likely");
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
