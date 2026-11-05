import { useCallback, useEffect, useRef, useState } from 'react'
import type { GridPage, GridQuery } from '@shared/types'

const PAGE = 200

/** Server-side filtering / sorting / paging for a grid. Re-queries (debounced) when q, filters, sort, extra or refreshKey change. */
export function useGridData<T>(fetchPage: (q: GridQuery) => Promise<GridPage<T>>, extra: Partial<GridQuery> = {}, refreshKey: unknown = 0) {
  const [q, setQ] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<GridQuery['sort']>(null)
  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [sumPaise, setSum] = useState(0)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const more = useRef(false)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const extraKey = JSON.stringify(extra)

  const query = useCallback((offset = 0, limit = PAGE): GridQuery => ({ q, filters, sort, limit, offset, ...JSON.parse(extraKey) }), [q, filters, sort, extraKey])

  const reload = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    try {
      const r = await fetchRef.current(query())
      if (id !== seq.current) return // a newer request already replaced this one
      setRows(r.rows); setTotal(r.total); setSum(r.sumPaise ?? 0)
    } finally { if (id === seq.current) setLoading(false) }
  }, [query])

  useEffect(() => {
    const t = setTimeout(reload, 180)
    return () => clearTimeout(t)
  }, [reload, refreshKey])

  const loadMore = useCallback(async () => {
    if (more.current || rows.length >= total) return
    more.current = true
    const id = seq.current
    try {
      const r = await fetchRef.current(query(rows.length))
      if (id === seq.current) setRows((p) => [...p, ...r.rows])
    } finally { more.current = false }
  }, [rows.length, total, query])

  const toggleSort = (key: string) =>
    setSort((s) => (!s || s.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null))
  const setFilter = (key: string, v: string) => setFilters((f) => ({ ...f, [key]: v }))
  const clearFilters = () => { setFilters({}); setQ('') }
  const patch = (match: (r: T) => boolean, next: T) => setRows((rs) => rs.map((r) => (match(r) ? next : r)))
  const drop = (match: (r: T) => boolean) => { setRows((rs) => rs.filter((r) => !match(r))); setTotal((t) => Math.max(0, t - 1)) }
  const hasFilters = !!q || Object.values(filters).some(Boolean)

  return { rows, total, sumPaise, loading, q, setQ, filters, setFilter, clearFilters, hasFilters, sort, toggleSort, setSort, reload, loadMore, patch, drop, query }
}
