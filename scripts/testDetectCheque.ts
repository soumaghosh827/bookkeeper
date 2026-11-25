import assert from "node:assert/strict";
import { detectInText } from "../src/main/services/docxDetect";

const got = (s: string, label?: string) =>
  detectInText(s, label).map((h) => [h.text, h.kind, h.confidence]);
const cq = (s: string, label?: string) =>
  got(s, label).filter((h) => h[1] === "cheque");
let n = 0;
const eq = (g: unknown, w: unknown, l: string) => {
  assert.deepEqual(g, w, l);
  n++;
};

eq(cq("Cheque No. 123456"), [["123456", "cheque", "likely"]], "Cheque No.");
eq(cq("Chq. No: 123456"), [["123456", "cheque", "likely"]], "Chq. No:");
eq(cq("Ch. No 123456"), [["123456", "cheque", "likely"]], "Ch. No");
eq(cq("CHEQUE NUMBER 123456"), [["123456", "cheque", "likely"]], "caps number");
eq(cq("Cheque #123456"), [["123456", "cheque", "likely"]], "hash");
eq(cq("vide cheque no. 123456 dated 12/11/2026"), [["123456", "cheque", "likely"]], "vide");
eq(got("vide cheque no. 123456 dated 12/11/2026").map((h) => h[1]), ["cheque", "date"], "vide + date");
eq(cq("Cheque No. 123456, 123457"), [["123456, 123457", "cheque", "likely"]], "two, comma");
eq(cq("Cheque No. 123456 and 123457"), [["123456 and 123457", "cheque", "likely"]], "two, and");
eq(cq("Your Cheque No. 123456"), [], "your skip");
eq(cq("their cheque no 123456"), [], "their skip");
eq(got("123456"), [], "bare 6 digits");
eq(cq("Account No. 123456789012345"), [], "account no");
eq(cq("Cheque No. 12"), [], "too short");
eq(cq("Cheque No. 1234567890123"), [], "too long");
eq(cq("Cheque Date 12/11/2026"), [], "cheque date");
eq(cq("Such no. 123456"), [], "'such no'");
eq(got("Ref. MAL/Acs/26-27/664 Cheque No. 123456").map((h) => h[1]), ["ref", "cheque"], "ref + cheque");
eq(cq("123456", "Cheque No."), [["123456", "cheque", "likely"]], "cell value");
eq(cq("123456", "Chq. No."), [["123456", "cheque", "likely"]], "cell value chq");
eq(cq("from account Cheque no. 123456 to our vendor"), [["123456", "cheque", "likely"]], "mid sentence");

console.log(`testDetectCheque: ${n} ok`);