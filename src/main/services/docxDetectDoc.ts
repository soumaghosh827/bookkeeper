/**
 * Document-level detection: walks a DocModel (body, headers, footers, table cells) and turns what
 * docxDetect finds in each paragraph into DocSuggestion[] in document order. Pure: no files, no database.
 * Suggestions only: the user decides.
 */
import type {
  DocBlock,
  DocModel,
  DocParagraph,
  DocSuggestion,
  DocTable,
} from "@shared/types";
import { detectInText, type HitKind } from "./docxDetect";

// Paragraph text exactly as docxModel counts offsets (runs joined, no separators)
const paraText = (p: DocParagraph): string =>
  p.runs.map((r) => r.text).join("");

const cellText = (blocks: DocBlock[]): string =>
  blocks
    .filter((b): b is DocParagraph => b.type === "p")
    .map(paraText)
    .join(" ")
    .trim();

// A neighbouring cell counts as a label when it is short and has a letter in it (Ref No, Dated:, Payee)
const looksLikeLabel = (t: string): boolean =>
  t.length > 0 && t.length <= 40 && /[A-Za-z]/.test(t);

// ---------- report table detection ----------
// Header words people use for each of the app's columns (normalised: lower case, letters and digits only).
// EXTEND HERE. A header matches a word when it equals it, or contains it (words of 5+ characters only).
// Order matters: specific columns first, generic "payee" last.
const COLUMN_WORDS: Record<string, string[]> = {
  sno: [
    "slno",
    "sno",
    "srno",
    "sl",
    "sr",
    "serialno",
    "serialnumber",
    "slnumber",
    "srnumber",
  ],
  bank: ["bank", "bankname", "nameofbank", "beneficiarybank", "payeebank"],
  branch: ["branch", "branchname", "nameofbranch"],
  account_no: [
    "accountnumber",
    "accountno",
    "accno",
    "acno",
    "acnumber",
    "accnumber",
  ],
  ifsc: ["ifsc", "ifscode", "ifsccode"],
  amount: ["amount", "amt", "netamount", "paymentamount"],
  reference_no: [
    "referenceno",
    "referencenumber",
    "refno",
    "refnumber",
    "ref",
    "reference",
  ],
  date: ["date", "dated", "paymentdate", "transactiondate", "valuedate"],
  utr: ["utr", "utrno", "utrnumber"],
  notes: ["notes", "note", "remarks", "remark", "narration"],
  payee: [
    "name",
    "payee",
    "payeename",
    "beneficiary",
    "beneficiaryname",
    "nameofbeneficiary",
    "nameofpayee",
    "accountholder",
    "accountholdername",
    "accountname",
    "customername",
  ],
};

const normHeader = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

function columnKeyOf(header: string, taken: Set<string>): string | undefined {
  const n = normHeader(header);
  if (!n) return undefined;
  for (const [key, words] of Object.entries(COLUMN_WORDS)) {
    if (taken.has(key)) continue;
    if (words.some((w) => n === w || (w.length >= 5 && n.includes(w))))
      return key;
  }
  return undefined;
}

// Offers the table as {@table} when a header row in it looks like the app's report table.
// The header can sit below banner or title rows, so each of the first MAX_HEADER_SCAN rows is scored by how many
// report columns it matches, and the best row wins (the earliest one on a tie). Returns true when offered.
const MAX_HEADER_SCAN = 25;
function detectTable(t: DocTable, ctx: Ctx): boolean {
  let best:
    | { i: number; shown: string[]; matched: string[]; size: number }
    | undefined;
  // "- 1" keeps at least one row below the header
  for (let i = 0; i < Math.min(MAX_HEADER_SCAN, t.rows.length - 1); i++) {
    const shown = t.rows[i].cells
      .map((c) => cellText(c.blocks))
      .filter(Boolean);
    if (shown.length < 3) continue;
    const taken = new Set<string>();
    const matched: string[] = [];
    for (const h of shown) {
      const key = columnKeyOf(h, taken);
      if (key) {
        taken.add(key);
        matched.push(h);
      }
    }
    // letterheads and label tables fail here: need 3+ columns incl. amount or payee
    if (taken.size < 3 || !(taken.has("amount") || taken.has("payee")))
      continue;
    if (!best || taken.size > best.size)
      best = { i, shown, matched, size: taken.size };
  }
  if (!best) return false;
  const summary = best.shown.join(" | ");
  ctx.out.push({
    id: "",
    kind: "table",
    addr: t.addr,
    text: summary.length > 80 ? summary.slice(0, 79) + "…" : summary,
    tag: "@table",
    options: ["@table"],
    confidence: best.size >= 4 ? "likely" : "possible",
    reason: `${best.size} of ${best.shown.length} columns match the app's report table`,
    table: {
      headers: best.shown,
      matched: best.matched,
      rows: t.rows.length - best.i - 1,
    },
  });
  return true;
}

interface Ctx {
  out: DocSuggestion[];
  // what each field suggestion was found as, so amounts can be paired with their words
  meta: Map<DocSuggestion, { kind: HitKind; paise?: number }>;
}

function suggestParagraph(p: DocParagraph, ctx: Ctx, cellLabel?: string) {
  const text = paraText(p);
  if (!text.trim()) return;
  for (const h of detectInText(text, cellLabel)) {
    const s: DocSuggestion = {
      id: "",
      kind: "field",
      addr: p.addr,
      start: h.start,
      end: h.end,
      text: h.text,
      tag: h.tag,
      options: [...h.options],
      confidence: h.confidence,
      reason: h.reason,
    };
    ctx.out.push(s);
    ctx.meta.set(s, { kind: h.kind, paise: h.paise });
  }
}

// ---------- constant text: the lines after "Yours faithfully" ----------
// EXTEND HERE: closing phrases, lines that end the signature block, suggested keys (first 3 lines).
const CLOSING =
  /^\s*(?:yours\s+(?:faithfully|sincerely|truly|respectfully)|thanking\s+you|(?:with\s+)?(?:best\s+|kind\s+|warm\s+)?regards)\b/i;
const SIG_STOP =
  /^\s*(?:encl|enclosure|enclosures|cc|c\.c|copy\s+to|note|ps|p\.s)\b/i;
const SIG_KEYS = ["signatory_name", "signatory_designation", "signatory_line3"];

interface SigState {
  n: number; // lines offered so far
  closing: string; // the closing phrase, for the reason text
}

// Offers one signature line as saved text. False = this paragraph ends the signature block.
function signatureLine(
  p: DocParagraph,
  text: string,
  sig: SigState,
  ctx: Ctx,
): boolean {
  const t = text.trim();
  if (t.length > 60 || SIG_STOP.test(t) || detectInText(text).length > 0)
    return false;
  const start = text.indexOf(t);
  const key = SIG_KEYS[sig.n];
  ctx.out.push({
    id: "",
    kind: "text",
    addr: p.addr,
    start,
    end: start + t.length,
    text: t,
    tag: key,
    options: [key],
    confidence: "possible",
    reason: `Below “${sig.closing}”: same text on every report`,
  });
  sig.n++;
  return true;
}

// `label`: text of the cell to the left, used only for the first non-empty paragraph of a cell
function walkBlocks(blocks: DocBlock[], ctx: Ctx, label?: string) {
  let pending = label;
  let sig: SigState | null = null;
  for (const b of blocks) {
    if (b.type === "p") {
      const text = paraText(b);
      const trimmed = text.trim();
      if (trimmed && sig) {
        const ok = signatureLine(b, text, sig, ctx);
        if (!ok || sig.n >= SIG_KEYS.length) sig = null;
        if (ok) {
          pending = undefined;
          continue;
        }
      }
      suggestParagraph(b, ctx, pending);
      if (trimmed) {
        pending = undefined;
        const m = CLOSING.exec(text);
        if (m) sig = { n: 0, closing: m[0].trim() };
      }
    } else {
      sig = null;
      if (detectTable(b, ctx)) continue;
      for (const row of b.rows) {
        let prev = "";
        for (const cell of row.cells) {
          walkBlocks(cell.blocks, ctx, looksLikeLabel(prev) ? prev : undefined);
          prev = cellText(cell.blocks);
        }
      }
    }
  }
}

/** All suggestions for a document, in document order, each with a unique id (s1, s2, ...). */
// Fields about the FIRST payee. In a letter that also has a table of payees, a value like this is more likely
// the writer's own detail (e.g. the account being debited), so it is only a possibility.
const PAYEE_LEVEL = new Set([
  "payee",
  "bank",
  "branch",
  "account_no",
  "ifsc",
  "utr",
  "reference_no",
  "amount",
  "amount_words",
  "notes",
  "date",
]);

export function detectDocument(model: DocModel): DocSuggestion[] {
  const ctx: Ctx = { out: [], meta: new Map() };
  for (const part of model.parts) walkBlocks(part.blocks, ctx);

  // an amount and its words in different (nearby) paragraphs: both are surely the total
  const samePara = (a: DocSuggestion, b: DocSuggestion) =>
    a.addr.part === b.addr.part &&
    a.addr.path.join(",") === b.addr.path.join(",");
  for (const w of ctx.out) {
    const wm = ctx.meta.get(w);
    if (!wm || wm.kind !== "words" || wm.paise === undefined) continue;
    const wi = ctx.out.indexOf(w);
    for (const a of ctx.out) {
      const am = ctx.meta.get(a);
      if (!am || am.kind !== "amount" || am.paise !== wm.paise) continue;
      if (a.addr.part !== w.addr.part || samePara(a, w)) continue; // same paragraph is already handled
      if (Math.abs(ctx.out.indexOf(a) - wi) > 4) continue;
      a.confidence = w.confidence = "likely";
      a.reason = `Matches the amount in words (${w.text.slice(0, 30)}…)`;
      w.reason = `Matches ${a.text}`;
      break;
    }
  }

  // an amount that differs from the one matching the words in the document may be another figure
  const wordsMatched = new Set<number>();
  for (const s of ctx.out) {
    const m = ctx.meta.get(s);
    if (
      m?.kind === "amount" &&
      m.paise !== undefined &&
      s.reason.startsWith("Matches the amount in words")
    )
      wordsMatched.add(m.paise);
  }
  if (wordsMatched.size)
    for (const s of ctx.out) {
      const m = ctx.meta.get(s);
      if (
        m?.kind === "amount" &&
        m.paise !== undefined &&
        !wordsMatched.has(m.paise) &&
        s.confidence === "likely"
      ) {
        s.confidence = "possible";
        s.reason =
          "Different from the amount in words, so it may be another figure";
      }
    }

  // a document with a table of payees: single-payee fields are probably the writer's own details
  if (ctx.out.some((s) => s.kind === "table"))
    for (const s of ctx.out)
      if (
        s.kind === "field" &&
        PAYEE_LEVEL.has(s.tag) &&
        s.confidence === "likely"
      ) {
        s.confidence = "possible";
        s.reason =
          "This document has a table of payees, so this may be your own detail";
      }

  ctx.out.forEach((s, i) => {
    s.id = `s${i + 1}`;
  });
  return ctx.out;
}
