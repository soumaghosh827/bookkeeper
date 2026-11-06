import { cleanIfsc, isValidIfsc } from "@shared/format";

export const clean = (s: string | undefined, max = 200) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
export const same = (a: string, b: string) =>
  clean(a).toLowerCase() === clean(b).toLowerCase();

export const COMPARE = [
  ["payee", "Beneficiary"],
  ["bank", "Bank"],
  ["branch", "Branch"],
  ["ifsc", "IFSC"],
] as const;

export type AccField = "payee" | "bank" | "branch" | "ifsc";
export interface FieldCandidate {
  value: string;
  source: "file" | "master";
  rows: number[]; // Excel rows with this value (empty for master)
  count: number;
}
export interface FieldConflict {
  field: AccField;
  label: string;
  candidates: FieldCandidate[];
  defaultValue: string; // what happens today if the user does nothing
  current: string; // value stored in the database today ("" for a new account or an empty field)
}

/** field -> value (first spelling seen) -> Excel rows carrying it */
export type SeenMap = Record<AccField, Map<string, number[]>>;
export const newSeen = (): SeenMap => ({
  payee: new Map(),
  bank: new Map(),
  branch: new Map(),
  ifsc: new Map(),
});
export function addSeen(
  seen: SeenMap,
  field: AccField,
  value: string,
  row: number,
) {
  const key = [...seen[field].keys()].find((x) => same(x, value)) ?? value;
  seen[field].set(key, [...(seen[field].get(key) ?? []), row]);
}

export interface StoredAcc {
  payee: string;
  bank: string;
  branch: string;
  ifsc: string;
}

/** Fields that need a decision: the file disagrees with itself, or with the stored account. */
export function buildFields(
  seen: SeenMap,
  values: Record<AccField, string>,
  cur?: StoredAcc,
): FieldConflict[] {
  const out: FieldConflict[] = [];
  for (const [f, label] of COMPARE) {
    const cands: FieldCandidate[] = [...seen[f].entries()].map(
      ([value, rows]) => ({
        value,
        source: "file" as const,
        rows: rows.slice(0, 20),
        count: rows.length,
      }),
    );
    const dbVal = cur ? cur[f] : "";
    const fileConflict = cands.length > 1;
    const masterDiff = !!(cur && cands.length && !same(cands[0].value, dbVal));
    if (!fileConflict && !masterDiff) continue;
    if (dbVal && !cands.some((c) => same(c.value, dbVal)))
      cands.unshift({ value: dbVal, source: "master", rows: [], count: 0 });
    out.push({
      field: f,
      label,
      candidates: cands,
      defaultValue: values[f],
      current: dbVal,
    });
  }
  return out;
}

export type FieldChoices = Record<string, Partial<Record<AccField, string>>>;

/** Keeps only picks for accounts in `valid`, cleans the values and rejects an invalid IFSC. */
export function sanitizeChoices(
  input: FieldChoices | undefined,
  valid: { has(key: string): boolean },
): Map<string, Partial<Record<AccField, string>>> {
  const out = new Map<string, Partial<Record<AccField, string>>>();
  for (const [key, c] of Object.entries(input ?? {})) {
    if (!valid.has(key)) continue;
    const o: Partial<Record<AccField, string>> = {};
    for (const [f] of COMPARE) {
      const raw = c?.[f];
      if (typeof raw !== "string") continue;
      const v = f === "ifsc" ? cleanIfsc(raw) : clean(raw);
      if (f === "ifsc" && v && !isValidIfsc(v))
        throw new Error("Invalid IFSC choice");
      if (v) o[f] = v;
    }
    if (Object.keys(o).length) out.set(key, o);
  }
  return out;
}

const TEXT_FIELDS = ["payee", "bank", "branch", "ifsc", "remarks"] as const;

export interface AccountFields {
  payee: string;
  bank: string;
  branch: string;
  ifsc: string;
  remarks: string;
  extra: string | null;
}

/**
 * Next stored state for an existing account, or null when nothing would change.
 * Order: bulk rule (non-empty file values only) first, explicit picks on top.
 */
export function applyAccountUpdate(
  cur: AccountFields,
  file: {
    values: Record<(typeof TEXT_FIELDS)[number], string>;
    extra: Record<string, unknown>;
  },
  ruleUpdate: boolean,
  pick?: Partial<Record<AccField, string>>,
): AccountFields | null {
  const curExtra = cur.extra ?? "{}";
  const next: AccountFields = {
    payee: cur.payee,
    bank: cur.bank,
    branch: cur.branch,
    ifsc: cur.ifsc,
    remarks: cur.remarks,
    extra: curExtra,
  };
  if (ruleUpdate) {
    for (const f of TEXT_FIELDS) if (file.values[f]) next[f] = file.values[f];
    next.extra = JSON.stringify({ ...JSON.parse(curExtra), ...file.extra });
  }
  if (pick) Object.assign(next, pick); // explicit picks win over the bulk rule
  const changed =
    TEXT_FIELDS.some((f) => next[f] !== cur[f]) || next.extra !== curExtra;
  return changed ? next : null;
}
