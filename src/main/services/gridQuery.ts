import { isCustomKey, type GridQuery } from "@shared/types";
import { parseAmount, parseDate } from "@shared/format";

/** Builds WHERE / ORDER BY for the two data grids. Column names come from a whitelist; user text is always a bound parameter. */
export interface ColDef {
  expr: string;
  kind?: "text" | "amount" | "date" | "count";
  sort?: string;
} // sort: expression to ORDER BY when it differs from the filter expression
export interface Built {
  where: string;
  params: unknown[];
  order: string;
  orderParams: unknown[];
}

export const esc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

type Parse = (s: string) => number | string | null;
function cmp(
  expr: string,
  text: string,
  parse: Parse,
): { sql: string; params: unknown[] } | null {
  const t = text.trim();
  let m = t.match(/^(>=|<=|>|<|=)\s*(.+)$/);
  if (m) {
    const v = parse(m[2]);
    return v == null ? null : { sql: `${expr} ${m[1]} ?`, params: [v] };
  }
  m = t.match(/^(.+?)\s*(?:\.\.|\s-\s)\s*(.+)$/); // "100..500" or "100 - 500"
  if (m) {
    const a = parse(m[1]),
      b = parse(m[2]);
    return a == null || b == null
      ? null
      : { sql: `${expr} BETWEEN ? AND ?`, params: [a, b] };
  }
  const v = parse(t);
  return v == null ? null : { sql: `${expr} = ?`, params: [v] };
}
const amountParse: Parse = (s) => {
  const p = parseAmount(s);
  return p.ok && p.paise != null ? p.paise : null;
};
const countParse: Parse = (s) =>
  s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : null;
const dateParse: Parse = (s) => parseDate(s);

export function buildGrid(
  cols: Record<string, ColDef>,
  extraCol: string,
  haystack: string,
  base: string[],
  q: GridQuery,
): Built {
  const where = [...base];
  const params: unknown[] = [];

  for (const tok of (q.q ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)) {
    where.push(`lower(${haystack}) LIKE ? ESCAPE '\\'`);
    params.push(`%${esc(tok)}%`);
  }
  for (const [key, raw] of Object.entries(q.filters ?? {})) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const col = cols[key];
    if (col) {
      if (col.kind === "amount" || col.kind === "count") {
        const c = cmp(
          col.expr,
          text,
          col.kind === "amount" ? amountParse : countParse,
        );
        if (c) {
          where.push(c.sql);
          params.push(...c.params);
        }
      } else if (col.kind === "date") {
        if (/^\d{4}(-\d{2}){0,2}$/.test(text)) {
          where.push(`${col.expr} LIKE ?`);
          params.push(text + "%");
        } else {
          const c = cmp(col.expr, text, dateParse);
          if (c) {
            where.push(c.sql);
            params.push(...c.params);
          }
        }
      } else {
        where.push(`lower(${col.expr}) LIKE ? ESCAPE '\\'`);
        params.push(`%${esc(text.toLowerCase())}%`);
      }
    } else if (isCustomKey(key)) {
      where.push(
        `lower(COALESCE(json_extract(${extraCol}, ?), '')) LIKE ? ESCAPE '\\'`,
      );
      params.push("$." + key, `%${esc(text.toLowerCase())}%`);
    }
  }

  let order = "";
  const orderParams: unknown[] = [];
  const s = q.sort;
  if (s) {
    const dir = s.dir === "desc" ? "DESC" : "ASC";
    const col = cols[s.key];
    if (col)
      order = `${col.sort ?? col.expr}${!col.kind || col.kind === "text" ? " COLLATE NOCASE" : ""} ${dir}`;
    else if (isCustomKey(s.key)) {
      order = `json_extract(${extraCol}, ?) COLLATE NOCASE ${dir}`;
      orderParams.push("$." + s.key);
    }
  }
  return { where: where.join(" AND "), params, order, orderParams };
}
