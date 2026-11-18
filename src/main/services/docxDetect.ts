/**
 * Finds possible replaceable values (dates, amounts, amounts in words, reference numbers, IFSC, account numbers,
 * labelled payee / bank / branch / UTR) in the joined text of ONE paragraph. Pure: no files, no database.
 * Everything it returns is only a suggestion: the user decides.
 *
 * VOCABULARY (extend here): REF_LABEL, DATE_LABEL, MONTHS, NUMBER_WORDS, LABELLED below.
 */

export type HitKind =
  | "date"
  | "amount"
  | "words"
  | "ref"
  | "ifsc"
  | "account"
  | "payee"
  | "bank"
  | "branch"
  | "utr";
export interface TextHit {
  start: number; // [start, end) in the paragraph text
  end: number;
  text: string;
  kind: HitKind;
  tag: string; // suggested default tag
  options: string[]; // every tag the dropdown should offer
  confidence: "likely" | "possible";
  reason: string;
  paise?: number; // amounts and amounts-in-words: the value, so callers can pair them
}

const H = String.raw`[^\S\r\n]`; // horizontal whitespace: space, tab, no-break space

// ---------- vocabulary ----------
const REF_LABEL = String.raw`(?<![A-Za-z])(?:our${H}+)?(?:ref(?:erence)?\.?${H}*(?:no|number|num|#)?\.?|letter${H}*(?:no|number)\.?|file${H}*(?:no|number)\.?)(?![A-Za-z])`;
const DATE_LABEL = String.raw`(?<![A-Za-z])(?:dated?|dt)\.?`;
const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_ABBR = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

type NW = {
  t: "unit" | "tens" | "hundred" | "scale" | "paise" | "and" | "filler";
  v: number;
};
const NUMBER_WORDS: Record<string, NW> = {};
{
  const units =
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
      " ",
    );
  units.forEach((w, i) => (NUMBER_WORDS[w] = { t: "unit", v: i }));
  const tens: [string, number][] = [
    ["twenty", 20],
    ["thirty", 30],
    ["forty", 40],
    ["fourty", 40],
    ["fifty", 50],
    ["sixty", 60],
    ["seventy", 70],
    ["eighty", 80],
    ["ninety", 90],
  ];
  for (const [w, v] of tens) NUMBER_WORDS[w] = { t: "tens", v };
  NUMBER_WORDS.hundred = { t: "hundred", v: 100 };
  const scales: [string, number][] = [
    ["thousand", 1e3],
    ["lakh", 1e5],
    ["lakhs", 1e5],
    ["lac", 1e5],
    ["lacs", 1e5],
    ["crore", 1e7],
    ["crores", 1e7],
    ["million", 1e6],
    ["billion", 1e9],
  ];
  for (const [w, v] of scales) NUMBER_WORDS[w] = { t: "scale", v };
  NUMBER_WORDS.paise = { t: "paise", v: 0 };
  NUMBER_WORDS.paisa = { t: "paise", v: 0 };
  NUMBER_WORDS.and = { t: "and", v: 0 };
  for (const w of ["rupees", "rupee", "rs", "only"])
    NUMBER_WORDS[w] = { t: "filler", v: 0 };
}

// ---------- small helpers ----------
const daysIn = (m: number, y: number) => new Date(y, m, 0).getDate();
const validDate = (d: number, m: number, y: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= daysIn(m, y);
const fullYear = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s));
const inr = (paise: number) =>
  "Rs. " +
  (paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** True when text[i] starts a new "cell-like" part of a line: paragraph start, after a tab/line break, or after 2+ spaces. */
function atSegmentStart(text: string, i: number): boolean {
  if (i <= 0) return true;
  if (text[i - 1] === "\t" || text[i - 1] === "\n") return true;
  return i >= 2 && /\s/.test(text[i - 1]) && /\s/.test(text[i - 2]);
}

interface Cand extends TextHit {
  priority: number; // lower wins an overlap
}
const mk = (
  c: Omit<TextHit, "text" | "options"> & {
    priority: number;
    options?: string[];
  },
  text: string,
): Cand => ({
  ...c,
  text: text.slice(c.start, c.end),
  options: c.options ?? [c.tag],
});

// ---------- labelled values ----------
interface LabelDef {
  kind: HitKind;
  tag: string;
  re: string; // the label, case-insensitive
  value: "free" | "token" | "digits" | "ifsc";
  reason: string;
}
const COLON = String.raw`${H}*[:\-–—]${H}*`;
const LABELLED: LabelDef[] = [
  {
    kind: "payee",
    tag: "payee",
    value: "free",
    reason: "payee",
    re: String.raw`(?<![A-Za-z])(?:name${H}+of${H}+(?:the${H}+)?(?:payee|beneficiary)|beneficiary${H}+(?:a\/c${H}+)?name|payee${H}+name|payee|beneficiary)${COLON}`,
  },
  {
    kind: "bank",
    tag: "bank",
    value: "free",
    reason: "bank",
    re: String.raw`(?<![A-Za-z])(?:name${H}+of${H}+(?:the${H}+)?bank|bank${H}+name|bank)${COLON}`,
  },
  {
    kind: "branch",
    tag: "branch",
    value: "free",
    reason: "branch",
    re: String.raw`(?<![A-Za-z])(?:branch${H}+name|branch)${COLON}`,
  },
  {
    kind: "account",
    tag: "account_no",
    value: "digits",
    reason: "account number",
    re: String.raw`(?<![A-Za-z])(?:a\/c|a\.c\.?|acc(?:ount)?\.?|ac)(?![A-Za-z])${H}*(?:no|number|num|#)?\.?${H}*(?:[:\-–—]${H}*)?`,
  },
  {
    kind: "ifsc",
    tag: "ifsc",
    value: "ifsc",
    reason: "IFSC",
    re: String.raw`(?<![A-Za-z])ifs[c]?(?![A-Za-z])(?:${H}*code)?${H}*(?:no\.?)?${COLON}?`,
  },
  {
    kind: "utr",
    tag: "utr",
    value: "token",
    reason: "UTR",
    re: String.raw`(?<![A-Za-z])utr(?![A-Za-z])(?:${H}*(?:no|number)\.?)?${H}*(?:[:\-–—]${H}*)?`,
  },
];

const REF_VALUE = String.raw`[A-Za-z0-9]+(?:[\/\-._][A-Za-z0-9]+|${H}?\/${H}?[A-Za-z0-9]+)*`;

function labelled(text: string, boundaries: number[], out: Cand[]) {
  // reference numbers
  const refRe = new RegExp(
    `(${REF_LABEL})([\\s:.\\-–—=#]*)(${REF_VALUE})`,
    "gi",
  );
  for (const m of text.matchAll(refRe)) {
    const labelStart = m.index!;
    if (
      /(?:your|ur|their)\s*$/i.test(
        text.slice(Math.max(0, labelStart - 12), labelStart),
      )
    )
      continue; // someone else's reference
    const val = m[3];
    if (!/\d/.test(val) || val.length < 2 || val.length > 40) continue;
    if (/^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(val)) continue; // that is a date
    const start = labelStart + m[1].length + m[2].length;
    out.push(
      mk(
        {
          start,
          end: start + val.length,
          kind: "ref",
          tag: "ref_no",
          options: ["ref_no", "reference_no"],
          confidence: "likely",
          reason: `Looks like “${m[1].replace(/[\s:\-–—.]+$/, "").trim()}”`,
          priority: 1,
        },
        text,
      ),
    );
  }
  for (const def of LABELLED) {
    const re = new RegExp(def.re, "gi");
    for (const m of text.matchAll(re)) {
      const vs = m.index! + m[0].length;
      let end = -1;
      if (def.value === "free") {
        const seg = /\t|\n|\s{2,}/.exec(text.slice(vs));
        end = seg ? vs + seg.index : text.length;
        const nextLabel = boundaries.find((b) => b > vs);
        if (nextLabel !== undefined && nextLabel < end) end = nextLabel;
        while (end > vs && /[\s,;.]/.test(text[end - 1])) end--;
      } else {
        const rest = text.slice(vs);
        const v =
          def.value === "digits"
            ? /^\d{9,18}(?!\d)/.exec(rest)
            : def.value === "ifsc"
              ? /^[A-Za-z0-9]{11}(?![A-Za-z0-9])/.exec(rest)
              : /^[A-Za-z0-9]{8,30}(?![A-Za-z0-9])/.exec(rest);
        if (!v || (def.value === "token" && !/\d/.test(v[0]))) continue;
        end = vs + v[0].length;
      }
      if (end - vs < 2) continue;
      out.push(
        mk(
          {
            start: vs,
            end,
            kind: def.kind,
            tag: def.tag,
            confidence: "likely",
            reason: `Looks like “${m[0].replace(/[\s:\-–—.]+$/, "").trim()}”`,
            priority: 1,
          },
          text,
        ),
      );
    }
  }
}

/** Starts of every label (any kind), so that free text stops where the next label begins. */
function labelStarts(text: string): number[] {
  const pats = [
    REF_LABEL,
    DATE_LABEL + String.raw`(?=${H}*[:\-–—])`,
    ...LABELLED.map((d) => d.re),
  ];
  const out: number[] = [];
  for (const p of pats)
    for (const m of text.matchAll(new RegExp(p, "gi"))) out.push(m.index!);
  return out.sort((a, b) => a - b);
}

// ---------- dates ----------
function dates(text: string, out: Cand[]) {
  const found: { start: number; end: number }[] = [];
  const add = (start: number, end: number, ok: boolean) =>
    ok && found.push({ start, end });

  for (const m of text.matchAll(
    /(?<![A-Za-z0-9\/])(\d{1,2})([\/.\-])(\d{1,2})\2(\d{4}|\d{2})(?![A-Za-z0-9\/])/g,
  ))
    add(
      m.index!,
      m.index! + m[0].length,
      validDate(+m[1], +m[3], fullYear(m[4])),
    );
  for (const m of text.matchAll(/(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g))
    add(m.index!, m.index! + m[0].length, validDate(+m[3], +m[2], +m[1]));
  const dmy = new RegExp(
    String.raw`(?<![A-Za-z0-9])(\d{1,2})(?:st|nd|rd|th)?([\s.,\-\/]*)(?:of\s+)?(${MONTHS})(?![a-z])\.?([\s.,\-\/]*)(\d{4}|\d{2})(?!\d)`,
    "gi",
  );
  for (const m of text.matchAll(dmy)) {
    const twoDigit = m[5].length === 2;
    if (twoDigit && !/[-\/.]/.test(m[4])) continue; // "18 May 25" is too loose; "18-May-25" is fine
    add(
      m.index!,
      m.index! + m[0].length,
      validDate(
        +m[1],
        MONTH_ABBR.indexOf(m[3].slice(0, 3).toLowerCase()) + 1,
        fullYear(m[5]),
      ),
    );
  }
  const mdy = new RegExp(
    String.raw`(?<![A-Za-z0-9])(${MONTHS})(?![a-z])\.?${H}+(\d{1,2})(?:st|nd|rd|th)?,?${H}+(\d{4})(?!\d)`,
    "gi",
  );
  for (const m of text.matchAll(mdy))
    add(
      m.index!,
      m.index! + m[0].length,
      validDate(
        +m[2],
        MONTH_ABBR.indexOf(m[1].slice(0, 3).toLowerCase()) + 1,
        +m[3],
      ),
    );

  for (const f of found) {
    const lab = new RegExp(`(${DATE_LABEL})(${H}*[:\\-–—]?\\s*)$`, "i").exec(
      text.slice(0, f.start),
    );
    let confidence: "likely" | "possible" = "possible";
    let reason = "Looks like a date";
    if (lab) {
      const labelAt = lab.index;
      const strong = /[:\-–—]/.test(lab[2]) || atSegmentStart(text, labelAt);
      confidence = strong ? "likely" : "possible";
      reason = strong
        ? `Looks like “${lab[1]}”`
        : `Looks like “${lab[1]}” inside a sentence`;
    }
    out.push(
      mk(
        {
          start: f.start,
          end: f.end,
          kind: "date",
          tag: "today",
          options: ["today", "date"],
          confidence,
          reason,
          priority: 6,
        },
        text,
      ),
    );
  }
}

// ---------- amounts ----------
const NUM = String.raw`\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const toPaise = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);

function amounts(text: string, out: Cand[]) {
  const cur = new RegExp(
    String.raw`(?<![A-Za-z0-9])(?:Rs\.?|INR|₹)${H}*[:\-]?${H}*(${NUM})(?!\d)(?:${H}*\/[-=])?`,
    "gi",
  );
  for (const m of text.matchAll(cur))
    out.push(
      mk(
        {
          start: m.index!,
          end: m.index! + m[0].length,
          kind: "amount",
          tag: "total",
          options: ["total", "amount"],
          confidence: "likely",
          reason: "Amount after Rs. / ₹",
          priority: 3,
          paise: toPaise(m[1]),
        },
        text,
      ),
    );
  const bare = /(?<![\d,.])\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?(?!\d)/g;
  for (const m of text.matchAll(bare))
    out.push(
      mk(
        {
          start: m.index!,
          end: m.index! + m[0].length,
          kind: "amount",
          tag: "total",
          options: ["total", "amount"],
          confidence: "possible",
          reason: "Looks like an amount",
          priority: 8,
          paise: toPaise(m[0]),
        },
        text,
      ),
    );
}

// ---------- amounts in words ----------
const evalGroup = (ws: string[]): number => {
  let total = 0;
  let cur = 0;
  for (const w of ws) {
    const n = NUMBER_WORDS[w];
    if (!n) continue;
    if (n.t === "unit" || n.t === "tens") cur += n.v;
    else if (n.t === "hundred") cur = (cur || 1) * 100;
    else if (n.t === "scale") {
      total += (cur || 1) * n.v;
      cur = 0;
    }
  }
  return total + cur;
};
const wordsToPaise = (ws: string[]): number => {
  const pi = ws.findIndex((w) => NUMBER_WORDS[w]?.t === "paise");
  if (pi < 0) return evalGroup(ws) * 100;
  const before = ws.slice(0, pi);
  const and = before.lastIndexOf("and");
  return and >= 0
    ? evalGroup(before.slice(0, and)) * 100 + evalGroup(before.slice(and + 1))
    : evalGroup(before);
};

function words(text: string, out: Cand[]) {
  const toks = [...text.matchAll(/[A-Za-z]+/g)].map((m) => ({
    w: m[0].toLowerCase(),
    s: m.index!,
    e: m.index! + m[0].length,
  }));
  let i = 0;
  while (i < toks.length) {
    if (!NUMBER_WORDS[toks[i].w]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < toks.length && NUMBER_WORDS[toks[j + 1].w]) {
      const gap = text.slice(toks[j].e, toks[j + 1].s);
      const okGap =
        /^[\s,\-]+$/.test(gap) || (toks[j].w === "rs" && /^\.[\s]*$/.test(gap));
      if (!okGap) break;
      j++;
    }
    let run = toks.slice(i, j + 1);
    i = j + 1;
    while (run.length && NUMBER_WORDS[run[0].w].t === "and") run = run.slice(1);
    while (run.length && NUMBER_WORDS[run[run.length - 1].w].t === "and")
      run = run.slice(0, -1);
    const ws = run.map((t) => t.w);
    const numeric = ws.filter((w) =>
      ["unit", "tens", "hundred", "scale"].includes(NUMBER_WORDS[w].t),
    );
    if (!numeric.length) continue;
    const hasFiller = ws.some(
      (w) => NUMBER_WORDS[w].t === "filler" || NUMBER_WORDS[w].t === "paise",
    );
    const hasScale = ws.some((w) =>
      ["hundred", "scale"].includes(NUMBER_WORDS[w].t),
    );
    if (!hasFiller && !(hasScale && numeric.length >= 2)) continue; // "one of", "ten days" are ordinary prose
    const paise = wordsToPaise(ws);
    out.push(
      mk(
        {
          start: run[0].s,
          end: run[run.length - 1].e,
          kind: "words",
          tag: "total_words",
          options: ["total_words", "amount_words"],
          confidence: hasFiller ? "likely" : "possible",
          reason: `Reads as ${inr(paise)} in words`,
          priority: 2,
          paise,
        },
        text,
      ),
    );
  }
}

// ---------- other patterns ----------
function patterns(text: string, out: Cand[]) {
  for (const m of text.matchAll(
    /(?<![A-Za-z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Za-z0-9])/g,
  ))
    out.push(
      mk(
        {
          start: m.index!,
          end: m.index! + m[0].length,
          kind: "ifsc",
          tag: "ifsc",
          confidence: "likely",
          reason: "Matches the IFSC pattern",
          priority: 4,
        },
        text,
      ),
    );
  for (const m of text.matchAll(
    /(?<![A-Za-z0-9\/])[A-Za-z]{2,}(?:[\/\-][A-Za-z0-9]+){2,}(?![A-Za-z0-9\/])/g,
  ))
    if (
      /\d/.test(m[0]) &&
      !/(?:your|ur|their)\s+(?:ref(?:erence)?\.?\s*(?:no|number)?\.?\s*[:\-]?\s*)$/i.test(
        text.slice(Math.max(0, m.index! - 30), m.index!),
      )
    )
      out.push(
        mk(
          {
            start: m.index!,
            end: m.index! + m[0].length,
            kind: "ref",
            tag: "ref_no",
            options: ["ref_no", "reference_no"],
            confidence: "possible",
            reason:
              "Looks like a reference number (letters, digits and slashes)",
            priority: 5,
          },
          text,
        ),
      );
  for (const m of text.matchAll(/(?<![\d,.\/-])\d{11,18}(?![\d,])/g))
    out.push(
      mk(
        {
          start: m.index!,
          end: m.index! + m[0].length,
          kind: "account",
          tag: "account_no",
          confidence: "possible",
          reason: "Long number: could be an account number",
          priority: 7,
        },
        text,
      ),
    );
}

/**
 * Suggestions for one paragraph's text, in text order, never overlapping.
 * `cellLabel`: when the paragraph is the VALUE cell next to a label cell (Ref No | BK/12/2026), pass the label text.
 */
export function detectInText(text: string, cellLabel?: string): TextHit[] {
  let probe = text;
  let shift = 0;
  if (cellLabel && cellLabel.trim()) {
    const pre = cellLabel.trim().replace(/[:\s]+$/, "") + ": ";
    probe = pre + text;
    shift = pre.length;
  }
  const all: Cand[] = [];
  labelled(probe, labelStarts(probe), all);
  words(probe, all);
  amounts(probe, all);
  patterns(probe, all);
  dates(probe, all);

  const taken: Cand[] = [];
  for (const c of [...all].sort(
    (a, b) => a.priority - b.priority || a.start - b.start,
  )) {
    if (c.start < shift) continue; // part of the label cell, not of this paragraph
    if (taken.some((t) => c.start < t.end && t.start < c.end)) continue;
    taken.push(c);
  }
  // an amount whose words appear in the same paragraph is surely a total: say so
  for (const w of taken.filter((t) => t.kind === "words"))
    for (const a of taken.filter(
      (t) => t.kind === "amount" && t.paise === w.paise,
    )) {
      a.confidence = w.confidence = "likely";
      a.reason = `Matches the amount in words (${w.text.slice(0, 30)}…)`;
      w.reason = `Matches ${a.text}`;
    }
  return taken
    .sort((a, b) => a.start - b.start)
    .map(({ priority: _p, ...h }) => ({
      ...h,
      start: h.start - shift,
      end: h.end - shift,
    }));
}
