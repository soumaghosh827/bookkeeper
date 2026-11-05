import { useEffect, useRef, useState } from 'react'

/**
 * Spreadsheet-style cell. Select with arrows/click; double-click or F2 edits; Enter saves and moves down;
 * Esc cancels. Saves on blur. If the save is refused (onCommit returns null) the old value comes back.
 */
export default function GridCell({ initial, editable, right, ri, colKey, onCommit }: {
  initial: string; editable: boolean; right?: boolean; ri: number; colKey: string
  onCommit?: (text: string) => Promise<string | null>
}) {
  const ref = useRef<HTMLInputElement>(null)
  const orig = useRef(initial)
  const busy = useRef(false) // blocks a second commit while one is in flight
  const [editing, setEditing] = useState(false)
  const can = editable && !!onCommit

  useEffect(() => {
    orig.current = initial
    if (ref.current && document.activeElement !== ref.current) ref.current.value = initial
  }, [initial])
  useEffect(() => { if (editing) ref.current?.select() }, [editing])

  const commit = async () => {
    const el = ref.current!
    if (busy.current || el.value === orig.current) return
    busy.current = true
    try {
      const shown = await onCommit!(el.value)
      if (shown === null) { el.value = orig.current; return }
      orig.current = shown; el.value = shown
    } finally { busy.current = false }
  }

  const neighbour = (dr: number, dc: number): HTMLInputElement | null => {
    const el = ref.current!
    if (dr) return el.closest('.dg')?.querySelector<HTMLInputElement>(`input.cell[data-ri="${ri + dr}"][data-col="${colKey}"]`) ?? null
    const cells = Array.from(el.parentElement!.querySelectorAll<HTMLInputElement>('input.cell'))
    return cells[cells.indexOf(el) + dc] ?? null
  }

  return (
    <input
      ref={ref}
      defaultValue={initial}
      readOnly={!can || !editing}
      data-ri={ri}
      data-col={colKey}
      className={`cell${can ? '' : ' ro'}${editing ? ' editing' : ''}${right ? ' r' : ''}`}
      spellCheck={false}
      autoComplete="off"
      title={initial || undefined}
      onDoubleClick={() => can && setEditing(true)}
      onBlur={() => { if (!editing) return; setEditing(false); commit() }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        const el = e.currentTarget
        if (!editing) {
          if (e.key === 'F2' && can) { e.preventDefault(); setEditing(true) }
          else if (e.key.startsWith('Arrow') || e.key === 'Enter') {
            const [dr, dc] = e.key === 'ArrowUp' ? [-1, 0] : e.key === 'ArrowDown' || e.key === 'Enter' ? [1, 0] : e.key === 'ArrowLeft' ? [0, -1] : [0, 1]
            e.preventDefault(); neighbour(dr, dc)?.focus()
          }
          return
        }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.value = orig.current; setEditing(false) }
        else if (e.key === 'Enter') {
          e.preventDefault(); setEditing(false)
          commit() // starts synchronously, so the blur that follows cannot double-save
          const next = neighbour(1, 0)
          next ? next.focus() : el.blur()
        }
      }}
    />
  )
}
