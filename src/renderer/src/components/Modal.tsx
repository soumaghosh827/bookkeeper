import { useEffect, useRef, type ReactNode } from 'react'

const stack: number[] = [] // only the top-most modal reacts to Esc
let nextId = 1

export default function Modal({ title, children, actions, onClose, wide }: {
  title?: string; children: ReactNode; actions?: ReactNode; onClose?: () => void; wide?: boolean
}) {
  const id = useRef(nextId++).current
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    stack.push(id)
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && stack[stack.length - 1] === id) { e.preventDefault(); close.current?.() } }
    window.addEventListener('keydown', f)
    return () => { window.removeEventListener('keydown', f); stack.splice(stack.indexOf(id), 1) }
  }, [id])
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close.current?.() }}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        {title && <h3>{title}</h3>}
        <div className="dlg-body">{children}</div>
        {actions && <div className="dlg-actions">{actions}</div>}
      </div>
    </div>
  )
}
