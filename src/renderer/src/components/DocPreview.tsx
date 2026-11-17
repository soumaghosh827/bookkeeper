import type { DocBlock, DocModel, DocParagraph, DocTable } from "@shared/types";

const PX_PER_PT = 96 / 72;
const HEX = /^[0-9a-f]{6}$/i;

// The file's real font first, then a sensible fallback (preview only; the saved file keeps the real name).
function fontStack(name: string) {
  const n = name.replace(/["\\]/g, "");
  const serif =
    /times|georgia|garamond|cambria|palatino|book antiqua|serif/i.test(n) &&
    !/sans/i.test(n);
  return `"${n}", ${serif ? 'Georgia, "Times New Roman", serif' : '"Segoe UI", Arial, sans-serif'}`;
}

function Para({ p, s }: { p: DocParagraph; s: number }) {
  const last = p.runs[p.runs.length - 1];
  return (
    <p
      className="docp-p"
      style={{
        textAlign: p.align,
        marginTop: (p.spaceBefore ?? 0) * s,
        marginBottom: (p.spaceAfter ?? 0) * s,
        minHeight: (last?.size ?? 11) * 1.25 * s, // an empty paragraph still takes a line
        tabSize: `${36 * s}px`,
      }}
    >
      {p.runs.map((r, i) => {
        const size = (r.size ?? 11) * s;
        if (r.image)
          return (
            <span key={i} className="docp-img" style={{ fontSize: size }}>
              [image]
            </span>
          );
        return (
          <span
            key={i}
            style={{
              fontFamily: r.font ? fontStack(r.font) : undefined,
              fontSize: size,
              fontWeight: r.bold ? 700 : undefined,
              fontStyle: r.italic ? "italic" : undefined,
              textDecoration: r.underline ? "underline" : undefined,
              color: r.color && HEX.test(r.color) ? `#${r.color}` : undefined,
            }}
          >
            {r.text}
          </span>
        );
      })}
    </p>
  );
}

function Tbl({ t, s }: { t: DocTable; s: number }) {
  return (
    <table className="docp-tbl">
      <colgroup>
        {t.colWidths.map((w, i) => (
          <col key={i} style={{ width: `${w * 100}%` }} />
        ))}
      </colgroup>
      <tbody>
        {t.rows.map((r, ri) => (
          <tr key={ri}>
            {r.cells.map((c, ci) => (
              <td
                key={ci}
                colSpan={c.span}
                className="docp-td"
                style={
                  c.shade && HEX.test(c.shade)
                    ? { background: `#${c.shade}` }
                    : undefined
                }
              >
                <Blocks blocks={c.blocks} s={s} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Blocks({ blocks, s }: { blocks: DocBlock[]; s: number }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.type === "p" ? (
          <Para key={i} p={b} s={s} />
        ) : (
          <Tbl key={i} t={b} s={s} />
        ),
      )}
    </>
  );
}

// Starts a new page at every paragraph flagged "page break before" (never an empty first page).
function paginate(blocks: DocBlock[]): DocBlock[][] {
  const pages: DocBlock[][] = [[]];
  for (const b of blocks) {
    if (b.type === "p" && b.pageBreakBefore && pages[pages.length - 1].length)
      pages.push([]);
    pages[pages.length - 1].push(b);
  }
  return pages;
}

/** Read-only Word pages: one white sheet per explicit page break, each with the header on top and the footer at the bottom. A sheet that overflows is not split again. */
export default function DocPreview({
  model,
  zoom = 1,
  print = false,
}: {
  model: DocModel;
  zoom?: number;
  print?: boolean; // paper output: no desk and no page padding (the print dialog supplies the margins)
}) {
  const s = zoom * PX_PER_PT;
  const { page } = model;
  const of = (k: "header" | "body" | "footer") =>
    model.parts.filter((p) => p.kind === k);
  const pages = paginate(of("body").flatMap((p) => p.blocks));
  return (
    <div className={print ? "docp-printwrap" : "docp-desk"}>
      {pages.map((blocks, n) => (
        <div
          key={n}
          className={print ? "docp-page docp-print" : "docp-page"}
          style={
            print
              ? { fontFamily: fontStack(model.defaultFont) }
              : {
                  width: page.width * s,
                  minHeight: page.height * s,
                  padding: `${page.margin.top * s}px ${page.margin.right * s}px ${page.margin.bottom * s}px ${page.margin.left * s}px`,
                  fontFamily: fontStack(model.defaultFont),
                }
          }
        >
          {of("header").map((p) => (
            <div key={p.part} className="docp-head">
              <Blocks blocks={p.blocks} s={s} />
            </div>
          ))}
          <div className="docp-body">
            <Blocks blocks={blocks} s={s} />
          </div>
          {of("footer").map((p) => (
            <div key={p.part} className="docp-foot">
              <Blocks blocks={p.blocks} s={s} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
