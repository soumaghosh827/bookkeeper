import assert from "node:assert/strict";
import { nextRef } from "../src/shared/format";

const NOV_2026 = new Date(2026, 10, 24); // financial year 26-27
const cases: [string, string | null, Date?][] = [
  // plain numbers
  ["REF-105", "REF-106"],
  ["BK/0105", "BK/0106"],
  ["REF-9", "REF-10"],
  ["REF-099", "REF-100"],
  ["0009", "0010"],
  ["  REF 7  ", "REF 8"],
  ["12345678901234567890", "12345678901234567891"],
  ["BK/105/", "BK/106/"],
  ["REF-105A", null],
  ["BK/105/A", null],
  ["REF", null],
  ["", null],
  // financial years
  ["BK/26-27/105", "BK/26-27/106"],
  ["BK/25-26/105", "BK/26-27/001"],
  ["BK/2025-26/0105", "BK/2026-27/0001"],
  ["BK/2025-2026/9", "BK/2026-2027/1"],
  ["BK/105/2025-26", "BK/001/2026-27"],
  ["REF/26-27", null],
  // plain years
  ["BK/105/2026", "BK/106/2026"],
  ["BK/105/2025", "BK/001/2026"],
  ["BK/2026", "BK/2027"],
  ["2025", "2026"],
  ["BK/2025/26/105", "BK/2026/27/001"],
  // other separators
  ["BK-26-27/105", "BK-26-27/106"],
  ["BK 26-27 105", "BK 26-27 106"],
  ["BK_25-26_105", "BK_26-27_001"],
  ["BK/26/27/105", "BK/26/27/106"],
  // not years: not consecutive, too old, or in the future
  ["BK/12-14/5", "BK/12-14/6"],
  ["BK/11/12/105", "BK/11/12/106"],
  ["ABC-12-13-007", "ABC-12-13-008"],
  ["REF-1001-1002", "REF-1001-1003"],
  ["BK/20-21/105", "BK/20-21/106"],
  ["BK/27-28/105", "BK/27-28/106"],
  ["BK/2020/105", "BK/2020/106"],
  ["BK/2030/105", "BK/2030/106"],
  ["REF-2030", "REF-2031"],
  // oldest year still inside the window
  ["BK/21-22/105", "BK/26-27/001"],
  ["BK/2021/105", "BK/2026/001"],
  // the cycle turns on 1 April; the calendar year on 1 January
  ["BK/26-27/105", "BK/26-27/106", new Date(2027, 2, 31)],
  ["BK/26-27/105", "BK/27-28/001", new Date(2027, 3, 1)],
  ["BK/105/2026", "BK/001/2027", new Date(2027, 0, 15)],
];
for (const [input, want, when] of cases) {
  assert.equal(
    nextRef(input, when ?? NOV_2026),
    want,
    `nextRef(${JSON.stringify(input)})`,
  );
}
console.log(`${cases.length} ok`);
