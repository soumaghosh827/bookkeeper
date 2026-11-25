import assert from "node:assert/strict";
import {
  chequeTokens,
  nextChequeNo,
  chequeIsSixDigit,
} from "../src/shared/format";

let n = 0;
const eq = <T,>(got: T, want: T, label: string) => {
  assert.deepEqual(got, want, label);
  n++;
};

eq(nextChequeNo("123456"), "123457", "plain");
eq(nextChequeNo("000999"), "001000", "padding kept");
eq(nextChequeNo("099999"), "100000", "carry");
eq(nextChequeNo("999999"), "1000000", "width grows");
eq(nextChequeNo("123456, 123457"), "123458", "last of two");
eq(nextChequeNo("123456; 123457 123460"), "123461", "mixed separators");
eq(nextChequeNo("CHQ-0042"), "CHQ-0043", "prefix");
eq(nextChequeNo("abc"), null, "no digit");
eq(nextChequeNo(""), null, "empty");

eq(chequeTokens(" 1 ,2;3  4 "), ["1", "2", "3", "4"], "tokens");
eq(chequeTokens(""), [], "tokens empty");

eq(chequeIsSixDigit(""), true, "empty is fine");
eq(chequeIsSixDigit("123456"), true, "six");
eq(chequeIsSixDigit("12345"), false, "five");
eq(chequeIsSixDigit("1234567"), false, "seven");
eq(chequeIsSixDigit("123456, 123457"), true, "two sixes");
eq(chequeIsSixDigit("123456, 12345"), false, "one short");
eq(chequeIsSixDigit("12345A"), false, "letter");

console.log(`testNextCheque: ${n} ok`);