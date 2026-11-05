import { useEffect, useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import GridCell from './GridCell'
import { rowHeight } from '@/lib/theme'

export interface GridCol { key: string; label: string; w: number; align?: 'right'; editable?: boolean; hint?: string }
const SEL_W = 38

/** Virtualized, server-driven grid: header sort, per-column filters, inline editing, optional row selection. */
export default function DataGrid<T>(p: {
  cols: GridCol[]; rows: T[]; total: number
  rowKey: (r: T) => string
  getText: (r: T, c: GridCol) => string
  onCommit?: (r: T, c: GridCol, text: string) => Promise<string | null>
  sort: { key: string; dir: 'asc' | 'desc' } | null | undefined; onSort: (key: string) => void
  filters: Record<string, string>; onFilter: (key: string, v: string) => void
  onNeedMore: () => void
  selected?: Set<string>; onSelect?: (s: Set<string>) => void
  actions?: (r: T) => ReactNode; actionsW?: number
  headerExtra?: ReactNode
  rowClass?: (r: T) => string
  empty?: string
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const last = useRef(-1)
  const rowH = rowHeight()
  const selectable = !!p.onSelect
  const actW = p.actions || p.headerExtra ? (p.actionsW ?? 44) : 0
  const tpl = (selectable ? `${SEL_W}px ` : '') + p.cols.map((c) => c.w + 'px').join(' ') + (actW ? ` ${actW}px` : '')
  const width = (selectable ? SEL_W : 0) + p.cols.reduce((n, c) => n + c.w, 0) + actW

  const v = useVirtualizer({ count: p.rows.length, getScrollElement: () => scroll.current, estimateSize: () => rowH, overscan: 12 })
  const items = v.getVirtualItems()
  const lastIdx = items.length ? items[items.length - 1].index : -1
  const needMore = lastIdx >= 0 && lastIdx >= p.rows.length - 20 && p.rows.length < p.total
  const more = useRef(p.onNeedMore); more.current = p.onNeedMore
  useEffect(() => { if (needMore) more.current() }, [needMore, p.rows.length])

  const sel = p.selected ?? new Set<string>()
  const allOn = p.rows.length > 0 && p.rows.every((r) => sel.has(p.rowKey(r)))
  function toggle(i: number, shift: boolean) {
    const next = new Set(sel)
    const keys = shift && last.current >= 0 ? p.rows.slice(Math.min(last.current, i), Math.max(last.current, i) + 1).map(p.rowKey) : [p.rowKey(p.rows[i])]
    const on = !sel.has(p.rowKey(p.rows[i]))
    keys.forEach((k) => (on ? next.add(k) : next.delete(k)))
    last.current = i
    p.onSelect!(next)
  }

  return (
    <div className="dg">
      <div className="dg-scroll" ref={scroll}>
        <div className="dg-headwrap" style={{ width }}>
          <div className="dg-row" style={{ gridTemplateColumns: tpl }}>
            {selectable && (
              <div className="dg-chk">
                <input type="checkbox" aria-label="Select all loaded rows" checked={allOn} onChange={() => p.onSelect!(allOn ? new Set() : new Set(p.rows.map(p.rowKey)))} />
              </div>
            )}
            {p.cols.map((c) => (
              <button key={c.key} className={`dg-th${c.align === 'right' ? ' r' : ''}${p.sort?.key === c.key ? ' on' : ''}`} title={`Sort by ${c.label}`} onClick={() => p.onSort(c.key)}>
                <span>{c.label}</span>
                {p.sort?.key === c.key && <span className="ind">{p.sort.dir === 'asc' ? '▲' : '▼'}</span>}
              </button>
            ))}
            {actW > 0 && <div className="dg-act">{p.headerExtra}</div>}
          </div>
          <div className="dg-row" style={{ gridTemplateColumns: tpl }}>
            {selectable && <div />}
            {p.cols.map((c) => (
              <div key={c.key} className="dg-fl">
                <input aria-label={`Filter ${c.label}`} placeholder={c.hint ?? 'Filter'} value={p.filters[c.key] ?? ''} onChange={(e) => p.onFilter(c.key, e.target.value)} />
              </div>
            ))}
            {actW > 0 && <div />}
          </div>
        </div>

        {p.rows.length === 0 && <div className="dg-empty">{p.empty ?? 'Nothing to show'}</div>}
        <div style={{ height: v.getTotalSize(), position: 'relative', width }}>
          {items.map((vi) => {
            const r = p.rows[vi.index]
            if (!r) return null
            const key = p.rowKey(r)
            return (
              <div key={key} className={`dg-row${sel.has(key) ? ' sel' : ''} ${p.rowClass?.(r) ?? ''}`}
                style={{ gridTemplateColumns: tpl, position: 'absolute', top: 0, left: 0, width, transform: `translateY(${vi.start}px)` }}>
                {selectable && (
                  <div className="dg-chk">
                    <input type="checkbox" aria-label="Select row" checked={sel.has(key)} onChange={() => {}} onClick={(e) => toggle(vi.index, e.shiftKey)} />
                  </div>
                )}
                {p.cols.map((c) => (
                  <GridCell key={c.key} ri={vi.index} colKey={c.key} initial={p.getText(r, c)} right={c.align === 'right'}
                    editable={!!c.editable} onCommit={p.onCommit ? (t) => p.onCommit!(r, c, t) : undefined} />
                ))}
                {actW > 0 && <div className="dg-act">{p.actions?.(r)}</div>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
