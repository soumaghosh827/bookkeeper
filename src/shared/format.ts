export const todayIso = () => {
  const d = new Date(); // local date, not UTC
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const fmtDate = (iso: string | null) =>
  iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "";

/** Accepts dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy or yyyy-mm-dd. Returns ISO or null. */
export function parseDate(s: string): string | null {
  const t = s.trim();
  let y: number, mo: number, d: number;
  let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
  if (m) {
    d = +m[1];
    mo = +m[2];
    y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  } else if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
  } else return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d)
    return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export const formatPaise = (p: number | null) =>
  p == null
    ? ""
    : (p / 100).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

/** "Rs. 34.00". Empty string when there is no amount, so a blank never prints a lone "Rs.". */
export const formatRs = (p: number | null) =>
  p == null ? "" : "Rs. " + formatPaise(p);

/** Amount column header: appends " (Rs.)" unless it already says Rs, ₹ or Rupee. Other columns pass through. */
export const tableHeader = (key: string, header: string) =>
  key === "amount" && !/\brs\b|₹|rupee/i.test(header)
    ? `${header} (Rs.)`
    : header;

export type ParsedAmount = { ok: true; paise: number | null } | { ok: false };
export function parseAmount(s: string): ParsedAmount {
  const t = s.replace(/[,\s₹]/g, "");
  if (!t) return { ok: true, paise: null }; // empty = no amount (needs confirmation on save)
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { ok: false };
  return { ok: true, paise: Math.round(Number(t) * 100) };
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];
const below100 = (n: number) =>
  n < 20
    ? ONES[n]
    : TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
const below1000 = (n: number) => {
  const h = Math.floor(n / 100),
    r = n % 100;
  return [h ? ONES[h] + " Hundred" : "", r ? below100(r) : ""]
    .filter(Boolean)
    .join(" ");
};
/** Indian system: Crore, Lakh, Thousand. */
export function rupeesInWords(paise: number): string {
  let n = Math.floor(paise / 100);
  const ps = paise % 100;
  if (n === 0 && ps === 0) return "Rupees Zero Only";
  const cr = Math.floor(n / 1e7);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  const th = Math.floor(n / 1e3);
  n %= 1e3;
  const parts = [
    cr
      ? (cr < 1000 ? below1000(cr) : cr.toLocaleString("en-IN")) + " Crore"
      : "",
    lakh ? below100(lakh) + " Lakh" : "",
    th ? below100(th) + " Thousand" : "",
    n ? below1000(n) : "",
  ].filter(Boolean);
  const rupees = parts.join(" ");
  const paiseWords = ps ? `${below100(ps)} Paise` : "";
  if (!rupees) return `${paiseWords} Only`; // paise only, e.g. "Twenty Five Paise Only"
  return `Rupees ${rupees}${paiseWords ? " and " + paiseWords : ""} Only`;
}

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const isValidIfsc = (s: string) => IFSC_RE.test(s);
export const cleanIfsc = (s: string) => s.replace(/\s/g, "").toUpperCase();

/** When the year part of a reference moves to a new year, should the number start again from 1? Set true if your series restarts every year. */
const RESET_SEQ_ON_NEW_YEAR = true;

/** How many past years (or financial years) still count as "a year" inside a reference. Anything older is treated as an ordinary number. */
const YEAR_WINDOW = 5;

/**
 * Suggests the reference that follows `ref`.
 *  - The last number outside any year goes up by one and keeps its zero padding ("BK/0105" -> "BK/0106").
 *  - A financial-year range (25-26, 2025-26, 2025-2026; April to March) moves to the current cycle, same format.
 *  - A plain year (2025) moves to the current calendar year.
 *  - Numbers count as a year only when they fall within the last YEAR_WINDOW years up to now; a pair must also be consecutive.
 *    So 11/12, 12-13 or a future 27-28 stay ordinary numbers.
 * null when there is no number to continue from.
 */
export function nextRef(ref: string, today: Date = new Date()): string | null {
  const s = ref.trim();
  const MARK = "\u0001";
  const cal = today.getFullYear();
  const fy = today.getMonth() >= 3 ? cal : cal - 1;
  const two = (n: number) => String(n % 100).padStart(2, "0");

  const bump = (masked: string, nowYear: string | null, changed: boolean) => {
    const q = masked.match(/^(.*?)(\d+)([^A-Za-z0-9]*)$/);
    if (!q) return null;
    const width = q[2].length;
    const n =
      RESET_SEQ_ON_NEW_YEAR && changed
        ? "1".padStart(width, "0")
        : (BigInt(q[2]) + BigInt(1)).toString().padStart(width, "0"); // BigInt: long numbers never lose digits
    const out = q[1] + n + q[3];
    return nowYear ? out.replace(MARK, nowYear) : out;
  };

  // 1) financial-year range: the first one that is consecutive and inside the window
  const re1 = /(?<!\d)(\d{4}|\d{2})(\s*[-–/]\s*)(\d{4}|\d{2})(?!\d)/g;
  for (let m = re1.exec(s); m; m = re1.exec(s)) {
    const a = m[1].length === 4 ? +m[1] : 2000 + +m[1];
    let b = m[3].length === 4 ? +m[3] : Math.floor(a / 100) * 100 + +m[3];
    if (b < a) b += 100;
    if (b !== a + 1 || a > fy || a < fy - YEAR_WINDOW) continue;
    const now =
      (m[1].length === 4 ? String(fy) : two(fy)) +
      m[2] +
      (m[3].length === 4 ? String(fy + 1) : two(fy + 1));
    const masked = s.slice(0, m.index) + MARK + s.slice(m.index + m[0].length);
    return bump(masked, now, m[0] !== now);
  }

  // 2) a plain year (the last one in the text) inside the window
  const re2 = /(?<!\d)\d{4}(?!\d)/g;
  let last: RegExpExecArray | null = null;
  for (let x = re2.exec(s); x; x = re2.exec(s))
    if (+x[0] <= cal && +x[0] >= cal - YEAR_WINDOW) last = x;
  if (last) {
    const now = String(cal);
    const masked = s.slice(0, last.index) + MARK + s.slice(last.index + 4);
    const r = bump(masked, now, last[0] !== now);
    if (r) return r; // else the year is the only number: treat it as a plain number below
  }

  // 3) no year: just the number
  return bump(s, null, false);
}
