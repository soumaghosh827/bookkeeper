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
  if (n === 0 && ps === 0) return "Zero Rupees";
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
  return `${parts.join(" ") || "Zero"} Rupees${ps ? " and " + below100(ps) + " Paise" : ""} Only`;
}


const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
export const isValidIfsc = (s: string) => IFSC_RE.test(s)
export const cleanIfsc = (s: string) => s.replace(/\s/g, '').toUpperCase()
