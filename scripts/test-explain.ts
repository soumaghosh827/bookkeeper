/**
 * Checks that broken { } tags give plain, correct messages.
 * Run:  npx tsx scripts/test-explain.ts
 */
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { explain } from "../src/main/services/explainError";

function makeDocx(text: string): Buffer {
  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generate({ type: "nodebuffer" });
}

/** Same way the app opens and fills a template. Returns the explained error, or null when no error. */
function run(text: string): string | null {
  try {
    const doc = new Docxtemplater(new PizZip(makeDocx(text)), {
      paragraphLoop: true,
      linebreaks: true,
      errorLogging: false,
    });
    doc.render({});
    return null;
  } catch (e) {
    return explain(e);
  }
}

// [name, text in the Word file, words the message must contain, words it must NOT contain]
const cases: [string, string, string[], string[]][] = [
  ["unclosed tag", "Dear {payee_name", ["payee_name", "closing }"], ["Multi error", "properties"]],
  ["unopened tag", "Dear payee_name} sir", ["payee_name", "no {"], ["properties"]],
  ["raw tag not alone", "See {@table} below", ["table", "own paragraph"], ["{@@"]],
  ["loop never closed", "{#rows} text", ["rows", "repeating"], ["properties"]],
  ["loop never started", "text {/rows}", ["rows", "repeating"], ["properties"]],
  ["loop mismatch", "{#aaa} text {/bbb}", ["aaa", "bbb", "do not match"], ["properties"]],
];

let bad = 0;
for (const [name, text, must, mustNot] of cases) {
  const msg = run(text);
  const okMsg =
    msg !== null &&
    must.every((w) => msg.includes(w)) &&
    mustNot.every((w) => !msg.includes(w));
  console.log(`${okMsg ? "ok  " : "FAIL"} ${name}\n     ${msg}`);
  if (!okMsg) bad++;
}

const empty = run("Hello {} there");
const okEmpty = empty === null;
console.log(`${okEmpty ? "ok  " : "FAIL"} empty {} gives no error${okEmpty ? "" : "\n     " + empty}`);
if (!okEmpty) bad++;

const good = run("Dear {payee_name}, total {total}");
const okGood = good === null;
console.log(`${okGood ? "ok  " : "FAIL"} good tags give no error${okGood ? "" : "\n     " + good}`);
if (!okGood) bad++;

console.log(bad ? `\n${bad} FAILED` : `\nAll ${cases.length + 2} ok`);
process.exit(bad ? 1 : 0);