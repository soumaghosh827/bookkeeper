import { writeFileSync } from "node:fs";
import {
  IMPORT_CASES,
  caseLabel,
  type CaseCode,
} from "../src/shared/importCases";

const SEVERITY = {
  rejected: "Row rejected",
  decision: "Needs a decision",
  info: "Information",
} as const;
const SCOPE = {
  both: "Master and transactions",
  master: "Master only",
  tx: "Transactions only",
} as const;
const FAMILIES: [string, string][] = [
  ["R", "Rows rejected"],
  ["A", "Accounts needing a decision"],
  ["T", "Transaction cases"],
  ["F", "Whole file"],
];

const cell = (s: string) => s.replace(/\|/g, "\\|");
const out: string[] = [
  "# Import cases",
  "",
  "Generated from `src/shared/importCases.ts` by `npm run docs:cases`. Do not edit by hand.",
  "",
];

for (const [letter, title] of FAMILIES) {
  const rows = Object.values(IMPORT_CASES).filter((c) => c.code[0] === letter);
  if (!rows.length) continue;
  out.push(
    `## ${title}`,
    "",
    "| Code | Where | Type | What the user sees | What to do | Default |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const c of rows)
    out.push(
      `| ${caseLabel(c.code as CaseCode)} | ${SCOPE[c.scope]} | ${SEVERITY[c.severity]} | ${cell(c.text)} | ${cell(c.fix)} | ${cell("defaultAction" in c ? (c.defaultAction ?? "") : "")} |`,
    );
  out.push("");
}

writeFileSync("IMPORT_CASES.md", out.join("\n"));
console.log(
  `IMPORT_CASES.md written (${Object.keys(IMPORT_CASES).length} cases)`,
);
