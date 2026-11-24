import { Fragment, useEffect, useRef, useState } from "react";
import type { ReportItemRow, ReportListRow } from "@shared/types";
import { fmtDate, formatPaise, parseDate } from "@shared/format";
import Icon from "../components/Icon";

const PAGE = 50;

/** Saved reports, newest first. Search and dates run in the database, so a long history stays fast. */
export default function ReportsScreen({ refreshKey }: { refreshKey: unknown }) {
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<ReportListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [items, setItems] = useState<ReportItemRow[] | null>(null); // null = loading
  const itemsSeq = useRef(0);

  function toggle(id: number) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    const my = ++itemsSeq.current;
    setOpenId(id);
    setItems(null);
    window.api.reports.items(id).then((r) => {
      if (my === itemsSeq.current) setItems(r); // ignore a reply for a row that was closed or replaced
    });
  }

  const fromIso = from.trim() ? parseDate(from.trim()) : "";
  const toIso = to.trim() ? parseDate(to.trim()) : "";
  const badFrom = !!from.trim() && !fromIso;
  const badTo = !!to.trim() && !toIso;
  const anyFilter = !!(q.trim() || from.trim() || to.trim());

  const query = (offset: number) =>
    window.api.reports.list({
      search: q.trim(),
      from: fromIso || "",
      to: toIso || "",
      limit: PAGE,
      offset,
    });

  // first page again when the search, a date or the data changes (short pause while typing)
  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    setOpenId(null);
    const t = setTimeout(async () => {
      const p = await query(0);
      if (id !== seq.current) return; // a newer search already replaced this one
      setRows(p.rows);
      setTotal(p.total);
      setLoading(false);
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, fromIso, toIso, refreshKey]);

  async function more() {
    const id = ++seq.current;
    setLoading(true);
    const p = await query(rows.length);
    if (id !== seq.current) return;
    setRows((r) => [...r, ...p.rows]);
    setTotal(p.total);
    setLoading(false);
  }

  return (
    <>
      <div className="toolbar">
        <h2>Reports</h2>
        <span className="stat">
          <b>{total.toLocaleString("en-IN")}</b> report
          {total === 1 ? "" : "s"}
          {anyFilter ? " (filtered)" : ""}
        </span>
        <input
          type="search"
          className="search"
          placeholder="Search reference, template or file…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="muted">From</span>
        <input
          className="rptdate"
          placeholder="dd/mm/yyyy"
          value={from}
          aria-invalid={badFrom}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span className="muted">To</span>
        <input
          className="rptdate"
          placeholder="dd/mm/yyyy"
          value={to}
          aria-invalid={badTo}
          onChange={(e) => setTo(e.target.value)}
        />
        {anyFilter && (
          <button
            className="ghost small"
            onClick={() => {
              setQ("");
              setFrom("");
              setTo("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="rptwrap">
        {rows.length === 0 ? (
          <div className="rptempty">
            {loading
              ? "Loading…"
              : anyFilter
                ? "No reports match these filters"
                : "No reports yet. Generate one on the Entry screen."}
          </div>
        ) : (
          <table className="pv rpt">
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference no</th>
                <th>Template</th>
                <th className="r">Transactions</th>
                <th className="r">Total (₹)</th>
                <th>File name</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr
                    className="rptrow"
                    onClick={() => toggle(r.id)}
                    aria-expanded={openId === r.id}
                  >
                    <td>
                      <Icon
                        name={openId === r.id ? "up" : "down"}
                        className="ic-inline rptchev"
                      />{" "}
                      {fmtDate(r.report_date)}
                    </td>
                    <td title={r.ref_no}>
                      {r.ref_no || <span className="faint">—</span>}
                    </td>
                    <td title={r.template_name}>{r.template_name}</td>
                    <td className="r">{r.item_count}</td>
                    <td className="r">{formatPaise(r.total_paise)}</td>
                    <td className="dim" title={r.file_name}>
                      {r.file_name}
                    </td>
                  </tr>
                  {openId === r.id && (
                    <tr className="rptdetail">
                      <td colSpan={6}>
                        {items === null ? (
                          <span className="muted">Loading…</span>
                        ) : items.length === 0 ? (
                          <span className="muted">No transactions</span>
                        ) : (
                          <table className="rptitems">
                            <tbody>
                              {items.map((it, i) => (
                                <tr key={it.uid}>
                                  <td className="n">{i + 1}</td>
                                  <td>{it.payee}</td>
                                  <td className="mono">{it.account_no}</td>
                                  <td>{fmtDate(it.entry_date)}</td>
                                  <td className="r">
                                    {formatPaise(it.amount_paise)}
                                  </td>
                                  <td>
                                    {it.deleted && (
                                      <span className="faint">deleted</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {rows.length < total && (
          <div className="rptmore">
            <button onClick={more} disabled={loading}>
              Show more ({(total - rows.length).toLocaleString("en-IN")} left)
            </button>
          </div>
        )}
      </div>
    </>
  );
}
