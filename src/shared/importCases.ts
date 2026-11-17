export type CaseScope = "both" | "master" | "tx";
export type CaseSeverity = "rejected" | "decision" | "info";

export interface ImportCase {
  code: string;
  scope: CaseScope;
  severity: CaseSeverity;
  text: string; // what the user sees
  fix: string; // what to tell the user to do
  defaultAction?: string;
}

const c = (x: ImportCase) => x;

export const IMPORT_CASES = {
  // R: row rejected
  R01: c({
    code: "R01",
    scope: "master",
    severity: "rejected",
    text: "Missing beneficiary",
    fix: "Fill the beneficiary name and import again",
  }),
  R02: c({
    code: "R02",
    scope: "tx",
    severity: "rejected",
    text: "Missing beneficiary for a new account",
    fix: "Add the name, or save the account in master first",
  }),
  R03: c({
    code: "R03",
    scope: "both",
    severity: "rejected",
    text: "Account number required",
    fix: "Fill the account number",
  }),
  R04: c({
    code: "R04",
    scope: "both",
    severity: "rejected",
    text: "Invalid IFSC",
    fix: "Correct the 11-character IFSC",
  }),
  R05: c({
    code: "R05",
    scope: "both",
    severity: "rejected",
    text: "Account number shown as 1.2E+15 style: Excel already lost its digits",
    fix: "Format the column as Text, retype the number and save again",
  }),
  R06: c({
    code: "R06",
    scope: "tx",
    severity: "rejected",
    text: "Amount missing, invalid, too large or over 2 decimals",
    fix: "Correct the amount",
  }),
  R07: c({
    code: "R07",
    scope: "tx",
    severity: "rejected",
    text: "Missing or unreadable date",
    fix: "Correct the date",
  }),
  // A: account needs a decision
  A01: c({
    code: "A01",
    scope: "both",
    severity: "decision",
    text: "Differs from master",
    fix: "Choose keep or update per field",
    defaultAction: "keep master",
  }),
  A02: c({
    code: "A02",
    scope: "both",
    severity: "decision",
    text: "Rows of one account disagree",
    fix: "Pick the correct value per field",
  }),
  A03: c({
    code: "A03",
    scope: "both",
    severity: "decision",
    text: "Looks like an existing or earlier account",
    fix: "Skip it, or add it as new",
    defaultAction: "master: skip, tx: add as new",
  }),
  A04: c({
    code: "A04",
    scope: "master",
    severity: "info",
    text: "Saved earlier as a one-off; added to master",
    fix: "None",
  }),
  A05: c({
    code: "A05",
    scope: "both",
    severity: "decision",
    text: "Long account number (16+ digits), not verified",
    fix: "Check it against the source, then choose Use as shown or Skip",
    defaultAction: "skip",
  }),
  // T: transaction cases
  T01: c({
    code: "T01",
    scope: "tx",
    severity: "info",
    text: "Same reference already saved",
    fix: "None, nothing added",
  }),
  T02: c({
    code: "T02",
    scope: "tx",
    severity: "decision",
    text: "Reference can link to a saved transaction",
    fix: "Link or add as new",
  }),
  T03: c({
    code: "T03",
    scope: "tx",
    severity: "decision",
    text: "Blank reference matches a saved transaction",
    fix: "Treat as the same or add as new",
  }),
  T04: c({
    code: "T04",
    scope: "tx",
    severity: "info",
    text: "Both have references, none shared: genuine twin",
    fix: "None, added",
  }),
  T05: c({
    code: "T05",
    scope: "tx",
    severity: "decision",
    text: "Duplicate inside the file",
    fix: "Keep or drop the later row",
  }),
  T06: c({
    code: "T06",
    scope: "tx",
    severity: "decision",
    text: "Amount is zero",
    fix: "Confirm or skip",
  }),
  T07: c({
    code: "T07",
    scope: "tx",
    severity: "decision",
    text: "High value",
    fix: "Confirm the amount",
  }),
  // F: whole file
  F01: c({
    code: "F01",
    scope: "both",
    severity: "info",
    text: "This file was already imported",
    fix: "Import again only if intended",
  }),
} as const;

export type CaseCode = keyof typeof IMPORT_CASES;

const FAMILY: Record<string, string> = {
  R: "ROW",
  A: "ACC",
  T: "TXN",
  F: "FILE",
};

/** Display form of a code, e.g. "A03" -> "ACC-03". Never looks like an Excel cell. */
export const caseLabel = (code: CaseCode): string =>
  `${FAMILY[code[0]]}-${code.slice(1)}`;
